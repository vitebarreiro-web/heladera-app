import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Plus, Bell, BellOff, X, Check, ShoppingCart, Package, Home, Trash2, AlertTriangle, SlidersHorizontal, ScanLine, Barcode, ChefHat, Menu, Users, Clock } from "lucide-react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db, FAMILY_CODE } from "./firebase";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

// ---------- helpers ----------
const todayISO = () => new Date().toISOString().slice(0, 10);

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayISO() + "T00:00:00");
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

function urgency(days) {
  if (days === null) return "none";
  if (days < 0) return "vencido";
  if (days <= 1) return "urgente";
  if (days <= 3) return "pronto";
  return "ok";
}

// Cuando hay más de un lote del mismo producto (ej. dos compras de "Masa de tarta"
// con fechas de vencimiento distintas), se numeran para diferenciarlos: "Masa de tarta 1", "2"...
function withBatchLabels(items) {
  const byName = {};
  for (const i of items) {
    const key = i.name.trim().toLowerCase();
    byName[key] = byName[key] || [];
    byName[key].push(i);
  }
  const labelById = {};
  for (const group of Object.values(byName)) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => {
      const da = a.expiry ?? "9999-99-99";
      const db = b.expiry ?? "9999-99-99";
      return da.localeCompare(db);
    });
    sorted.forEach((i, idx) => { labelById[i.id] = `${i.name} ${idx + 1}`; });
  }
  return (item) => labelById[item.id] || item.name;
}

const URGENCY_STYLES = {
  vencido: { bg: "#C4432E", text: "#FFF7F0", label: "Vencido" },
  urgente: { bg: "#C4432E", text: "#FFF7F0", label: "Vence ya" },
  pronto: { bg: "#D6A226", text: "#2A2115", label: "Vence pronto" },
  ok: { bg: "#4C7A6C", text: "#F3F7F1", label: "Fresco" },
  none: { bg: "#B9B2A5", text: "#2A2115", label: "Sin fecha" },
};

const CATEGORIES = ["Lácteos", "Verdura/Fruta", "Carnes", "Fiambres", "Almacén", "Otros"];
const UNITS = ["un.", "kg", "g", "l", "ml", "paq."];

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- scanner helpers ----------
// Beep sintetizado (sin archivo de audio externo) al detectar un código.
function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 1046.5;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {}
}

// Busca el nombre del producto en Open Food Facts a partir del código de barras.
async function lookupBarcode(code) {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code}.json`);
    const data = await res.json();
    if (data.status === 1 && data.product) {
      return {
        name: data.product.product_name || data.product.product_name_es || null,
      };
    }
  } catch {}
  return { name: null };
}

// ---------- storage (Firestore compartido entre todos los que usen el mismo FAMILY_CODE) ----------
const familyDocRef = doc(db, "families", FAMILY_CODE);

const SEED_ITEMS = [
  { id: uid(), name: "Leche", category: "Lácteos", stock: 2, minStock: 3, unit: "un.", expiry: null, essential: true },
  { id: uid(), name: "Jamón", category: "Fiambres", stock: 1, minStock: 1, unit: "paq.", expiry: addDays(2), essential: true },
  { id: uid(), name: "Queso", category: "Fiambres", stock: 1, minStock: 1, unit: "paq.", expiry: addDays(6), essential: true },
  { id: uid(), name: "Huevos", category: "Almacén", stock: 6, minStock: 6, unit: "un.", expiry: addDays(12), essential: false },
  { id: uid(), name: "Tapas de tarta", category: "Congelados", stock: 1, minStock: 2, unit: "paq.", expiry: addDays(30), essential: false },
];
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- main ----------
export default function App() {
  const [items, setItems] = useState([]);
  const [manualShopping, setManualShopping] = useState([]);
  const [view, setView] = useState("home");
  const [loaded, setLoaded] = useState(false);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [showAddItem, setShowAddItem] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [newShoppingText, setNewShoppingText] = useState("");
  const [toast, setToast] = useState(null);
  const [showEssentials, setShowEssentials] = useState(false);
  const [buyPrompt, setBuyPrompt] = useState(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scanPrefill, setScanPrefill] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [showRecipeModal, setShowRecipeModal] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState(null);
  const [showMenu, setShowMenu] = useState(false);

  // Suscripción en tiempo real: cualquier cambio que haga otro celular con el mismo
  // FAMILY_CODE llega solo, sin recargar la página.
  const skipNextWrite = useRef(true);
  useEffect(() => {
    const unsub = onSnapshot(
      familyDocRef,
      (snap) => {
        const data = snap.data();
        skipNextWrite.current = true; // lo que llega de Firestore no hay que reescribirlo
        setItems(data?.items ?? []);
        setManualShopping(data?.manual ?? []);
        setRecipes(data?.recipes ?? []);
        setLoaded(true);
      },
      () => setLoaded(true) // si falla la conexión, igual dejamos usar la app (local)
    );
    return () => unsub();
  }, []);

  // Cada cambio local (agregar, tocar stock, etc.) se sube a Firestore para que
  // lo vean los demás celulares. Se salta el primer disparo después de cada
  // snapshot recibido, para no reescribir lo que acaba de llegar.
  useEffect(() => {
    if (!loaded) return;
    if (skipNextWrite.current) { skipNextWrite.current = false; return; }
    setDoc(familyDocRef, { items, manual: manualShopping, recipes }, { merge: true }).catch(() => {});
  }, [items, manualShopping, recipes, loaded]);

  const [toastVisible, setToastVisible] = useState(false);
  const showToast = useCallback((msg) => {
    setToast(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 1500);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // derived
  const expiringItems = useMemo(() => {
    return items
      .filter((i) => i.expiry && i.stock > 0)
      .map((i) => ({ ...i, days: daysUntil(i.expiry) }))
      .filter((i) => i.days <= 5)
      .sort((a, b) => a.days - b.days);
  }, [items]);

  const stockGroups = useMemo(() => {
    const map = {};
    for (const i of items) {
      const key = i.name.trim().toLowerCase();
      if (!map[key]) {
        map[key] = { key, name: i.name, category: i.category, unit: i.unit, minStock: i.minStock, totalStock: 0, items: [] };
      }
      map[key].totalStock += i.stock;
      map[key].minStock = Math.max(map[key].minStock, i.minStock);
      map[key].items.push(i);
    }
    return Object.values(map);
  }, [items]);

  const autoShopping = useMemo(
    () => stockGroups.filter((g) => g.totalStock < g.minStock),
    [stockGroups]
  );

  const lowStockKeys = useMemo(
    () => new Set(autoShopping.map((g) => g.key)),
    [autoShopping]
  );

  const displayName = useMemo(() => withBatchLabels(items), [items]);

  const shoppingCount = autoShopping.length + manualShopping.filter((m) => !m.checked).length;

  // notifications: check periodically while app is open/foreground
  // (usa una ref para no reiniciar el intervalo cada vez que cambia el stock)
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    if (notifPermission !== "granted") return;
    const check = () => {
      const urgent = itemsRef.current.filter((i) => {
        if (i.stock <= 0) return false;
        const d = daysUntil(i.expiry);
        return d !== null && d <= 1;
      });
      if (urgent.length > 0) {
        const names = urgent.map((i) => i.name).join(", ");
        new Notification("🧊 La Heladera", {
          body: `Se vence ya: ${names}`,
          tag: "heladera-vencimientos",
        });
      }
    };
    check();
    const id = setInterval(check, 1000 * 60 * 60 * 6); // cada 6hs mientras esté abierta
    return () => clearInterval(id);
  }, [notifPermission]);

  async function requestNotifications() {
    if (typeof Notification === "undefined") {
      showToast("Acá adentro no se puede activar. Hay que instalar la app aparte.");
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      if (perm === "granted") showToast("Notificaciones activadas");
      else showToast("Permiso no otorgado");
    } catch {
      showToast("Acá adentro no se puede activar. Hay que instalar la app aparte.");
    }
  }

  function updateItem(id, patch) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }
  function removeItem(id) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }
  function addItem(item) {
    setItems((prev) => [...prev, { ...item, id: uid() }]);
    showToast("Agregado a la heladera");
  }
  function adjustStock(id, delta) {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, stock: Math.max(0, i.stock + delta) } : i))
    );
  }
  function markBought(key) {
    const group = autoShopping.find((g) => g.key === key) ??
      (() => {
        // por si se llama para algo no bajo mínimo (ej. reponer manualmente)
        const group = items.filter((i) => i.name.trim().toLowerCase() === key);
        if (!group.length) return null;
        const totalStock = group.reduce((s, i) => s + i.stock, 0);
        const minStock = Math.max(...group.map((i) => i.minStock));
        return { key, name: group[0].name, category: group[0].category, unit: group[0].unit, minStock, totalStock, items: group };
      })();
    if (!group) return;
    setBuyPrompt(group);
  }
  function confirmPurchase({ group, quantity, expiry }) {
    setItems((prev) => {
      // buscar un lote existente para sumarle: sin stock, o con la misma fecha
      const target = group.items.find((i) => i.stock === 0) ??
        group.items.find((i) => (i.expiry ?? null) === (expiry || null));
      if (target) {
        return prev.map((i) =>
          i.id === target.id ? { ...i, stock: i.stock + quantity, expiry: expiry || i.expiry } : i
        );
      }
      // ningún lote coincide: se crea uno nuevo
      const rep = group.items[0];
      return [
        ...prev,
        {
          id: uid(),
          name: rep.name,
          category: rep.category,
          unit: rep.unit,
          essential: rep.essential,
          minStock: group.minStock,
          stock: quantity,
          expiry: expiry || null,
        },
      ];
    });
    setBuyPrompt(null);
    showToast("Agregado a la heladera");
  }
  function addManualShopping() {
    const text = newShoppingText.trim();
    if (!text) return;
    setManualShopping((prev) => [...prev, { id: uid(), name: text, checked: false }]);
    setNewShoppingText("");
  }
  function toggleManual(id) {
    setManualShopping((prev) =>
      prev.map((m) => (m.id === id ? { ...m, checked: !m.checked } : m))
    );
  }
  function clearCheckedManual() {
    setManualShopping((prev) => prev.filter((m) => !m.checked));
  }

  function saveRecipe(data) {
    if (editingRecipe) {
      setRecipes((prev) => prev.map((r) => (r.id === editingRecipe.id ? { ...r, ...data } : r)));
    } else {
      setRecipes((prev) => [...prev, { id: uid(), ...data }]);
    }
    setShowRecipeModal(false);
    setEditingRecipe(null);
  }
  function removeRecipe(id) {
    setRecipes((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleBarcodeDetected(code) {
    setShowScanner(false);
    // si ese código ya existe en algún producto, vamos directo a editarlo (sumarle stock)
    const existing = items.find((i) => i.barcode === code);
    if (existing) {
      setEditingItem(existing);
      setScanPrefill(null);
      setShowAddItem(true);
      return;
    }
    showToast("Código escaneado, buscando producto…");
    const { name } = await lookupBarcode(code);
    setEditingItem(null);
    setScanPrefill({ barcode: code, name: name || "" });
    setShowAddItem(true);
  }

  if (!loaded) {
    return (
      <div style={{ background: BG }} className="min-h-screen flex items-center justify-center">
        <p className="text-[#6b6355] font-medium">Abriendo la heladera…</p>
      </div>
    );
  }

  return (
    <div style={{ background: BG, fontFamily: "'Manrope', sans-serif" }} className="min-h-screen pb-24 text-[#241E17]">
      <style>{FONT_IMPORT}</style>

      <Header
        shoppingCount={shoppingCount}
        notifPermission={notifPermission}
        onRequestNotif={requestNotifications}
        onOpenEssentials={() => setShowEssentials(true)}
        onOpenMenu={() => setShowMenu(true)}
      />

      <main className="max-w-md mx-auto px-4 pt-4">
        {view === "home" && (
          <HomeView
            expiringItems={expiringItems}
            autoShopping={autoShopping}
            manualShopping={manualShopping}
            onMarkBought={markBought}
            onToggleManual={toggleManual}
            onGoInventory={() => setView("inventory")}
            onGoShopping={() => setView("shopping")}
            displayName={displayName}
          />
        )}
        {view === "inventory" && (
          <InventoryView
            items={items}
            onAdjust={adjustStock}
            onEdit={(item) => { setEditingItem(item); setShowAddItem(true); }}
            onRemove={removeItem}
            onAdd={() => { setEditingItem(null); setScanPrefill(null); setShowAddItem(true); }}
            onScan={() => setShowScanner(true)}
            displayName={displayName}
            lowStockKeys={lowStockKeys}
          />
        )}
        {view === "cocina" && (
          <CocinaView
            recipes={recipes}
            items={items}
            onAdd={() => { setEditingRecipe(null); setShowRecipeModal(true); }}
            onEdit={(r) => { setEditingRecipe(r); setShowRecipeModal(true); }}
            onRemove={removeRecipe}
          />
        )}
        {view === "shopping" && (
          <ShoppingView
            autoShopping={autoShopping}
            manualShopping={manualShopping}
            newShoppingText={newShoppingText}
            setNewShoppingText={setNewShoppingText}
            onAddManual={addManualShopping}
            onMarkBought={markBought}
            onToggleManual={toggleManual}
            onClearChecked={clearCheckedManual}
            displayName={displayName}
          />
        )}
      </main>

      <NavBar view={view} setView={setView} shoppingCount={shoppingCount} />

      {buyPrompt && (
        <BuyPromptModal
          group={buyPrompt}
          onClose={() => setBuyPrompt(null)}
          onConfirm={(data) => confirmPurchase(data)}
        />
      )}

      {showEssentials && (
        <EssentialsModal
          items={items}
          onClose={() => setShowEssentials(false)}
          onChangeMin={(nameKey, minStock) =>
            setItems((prev) =>
              prev.map((i) =>
                i.name.trim().toLowerCase() === nameKey
                  ? { ...i, minStock: Math.max(0, minStock) }
                  : i
              )
            )
          }
          onToggleEssential={(nameKey) =>
            setItems((prev) =>
              prev.map((i) =>
                i.name.trim().toLowerCase() === nameKey ? { ...i, essential: false } : i
              )
            )
          }
          onQuickAdd={(data) =>
            addItem({ ...data, stock: 0, expiry: null, essential: true })
          }
        />
      )}

      {showAddItem && (
        <ItemModal
          item={editingItem}
          prefill={scanPrefill}
          onClose={() => { setShowAddItem(false); setScanPrefill(null); }}
          onSave={(data) => {
            if (editingItem) updateItem(editingItem.id, data);
            else addItem(data);
            setShowAddItem(false);
            setScanPrefill(null);
          }}
        />
      )}

      {showScanner && (
        <ScannerModal
          onClose={() => setShowScanner(false)}
          onDetected={handleBarcodeDetected}
        />
      )}

      {showRecipeModal && (
        <RecipeModal
          recipe={editingRecipe}
          onClose={() => { setShowRecipeModal(false); setEditingRecipe(null); }}
          onSave={saveRecipe}
        />
      )}

      {showMenu && (
        <MenuPanel
          view={view}
          onNavigate={(v) => { setView(v); setShowMenu(false); }}
          onClose={() => setShowMenu(false)}
        />
      )}

      {toast && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-white text-[#241E17] text-sm font-semibold px-4 py-2 rounded-full shadow-lg border border-[#EAE4D6] z-50 transition-all duration-500"
          style={{ opacity: toastVisible ? 1 : 0, transform: `translate(-50%, ${toastVisible ? "0" : "6px"})` }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

const BG = "#F7F4EE";
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap');`;

// ---------- Header ----------
function Header({ shoppingCount, notifPermission, onRequestNotif, onOpenEssentials, onOpenMenu }) {
  return (
    <header className="pt-6 pb-3 px-4 max-w-md mx-auto flex items-start justify-between">
      <div className="flex items-start gap-2">
        <button
          onClick={onOpenMenu}
          className="w-9 h-9 mt-1 rounded-full flex items-center justify-center bg-[#E8E2D4] text-[#6b6355] shrink-0"
          aria-label="Menú"
        >
          <Menu size={18} />
        </button>
        <div>
          <h1
            style={{ fontFamily: "'Fraunces', serif" }}
            className="text-3xl font-semibold tracking-tight text-[#1C2B2D]"
          >
            La Heladera
          </h1>
          <p className="text-sm text-[#847B69] mt-0.5">
            {shoppingCount > 0
              ? `${shoppingCount} cosa${shoppingCount > 1 ? "s" : ""} para comprar`
              : "Todo al día"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 mt-1">
        <button
          onClick={onOpenEssentials}
          className="w-10 h-10 rounded-full flex items-center justify-center transition bg-[#E8E2D4] text-[#6b6355]"
          aria-label="Ajustar esenciales"
        >
          <SlidersHorizontal size={17} />
        </button>
        <button
          onClick={onRequestNotif}
          className="w-10 h-10 rounded-full flex items-center justify-center transition"
          style={{
            background: notifPermission === "granted" ? "#4C7A6C" : "#E8E2D4",
            color: notifPermission === "granted" ? "#F3F7F1" : "#6b6355",
          }}
          aria-label="Notificaciones"
        >
          {notifPermission === "granted" ? <Bell size={18} /> : <BellOff size={18} />}
        </button>
      </div>
    </header>
  );
}

// ---------- Menu ----------
function MenuPanel({ view, onNavigate, onClose }) {
  const options = [
    { key: "inventory", label: "Heladera", icon: Package, enabled: true },
    { key: "cocina", label: "Cocina", icon: ChefHat, enabled: true },
    { key: "familia", label: "Usuario / Familia", icon: Users, enabled: false },
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-[#F7F4EE] w-72 max-w-[80vw] h-full p-5 space-y-1 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold text-[#1C2B2D]">
            Menú
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-[#EFEAE0] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>

        {options.map(({ key, label, icon: Icon, enabled }) => (
          <button
            key={key}
            disabled={!enabled}
            onClick={() => enabled && onNavigate(key)}
            className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left ${
              enabled
                ? view === key
                  ? "bg-[#1C2B2D] text-[#F7F4EE]"
                  : "bg-white text-[#241E17]"
                : "bg-transparent text-[#B0A895]"
            }`}
          >
            <Icon size={18} />
            <span className="flex-1 font-semibold text-sm">{label}</span>
            {!enabled && (
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-[#B0A895]">
                <Clock size={11} /> Próximamente
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Essentials ----------
function EssentialsModal({ items, onClose, onChangeMin, onToggleEssential, onQuickAdd }) {
  // agrupa por nombre de producto: si "Leche" tiene 2 lotes marcados esenciales,
  // se muestra UNA sola fila con el mínimo compartido (evita que se desincronicen)
  const essentialGroups = useMemo(() => {
    const essentialKeys = new Set(
      items.filter((i) => i.essential).map((i) => i.name.trim().toLowerCase())
    );
    const map = {};
    for (const i of items) {
      const key = i.name.trim().toLowerCase();
      if (!essentialKeys.has(key)) continue;
      if (!map[key]) map[key] = { key, name: i.name, category: i.category, unit: i.unit, minStock: 0 };
      map[key].minStock = Math.max(map[key].minStock, i.minStock);
    }
    return Object.values(map);
  }, [items]);

  const grouped = useMemo(() => {
    const map = {};
    for (const g of essentialGroups) {
      map[g.category] = map[g.category] || [];
      map[g.category].push(g);
    }
    return map;
  }, [essentialGroups]);

  const [showQuickAdd, setShowQuickAdd] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-end justify-center z-50" onClick={onClose}>
      <div
        className="bg-[#FBF9F4] w-full max-w-md rounded-t-3xl p-5 pb-8 space-y-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 style={{ fontFamily: "'Fraunces', serif" }} className="text-xl font-semibold text-[#1C2B2D]">
              Stock esencial
            </h3>
            <p className="text-xs text-[#9C927E] mt-0.5">
              Lo que siempre tiene que haber. Ajustá el mínimo o sumá/sacá cosas de esta lista.
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-[#F0EBDD] flex items-center justify-center shrink-0">
            <X size={16} />
          </button>
        </div>

        {essentialGroups.length === 0 && !showQuickAdd && (
          <EmptyNote text="Todavía no marcaste nada como esencial." />
        )}

        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat}>
            <p className="text-xs font-bold uppercase tracking-wide text-[#9C927E] mb-2">{cat}</p>
            <div className="space-y-2">
              {list.map((g) => (
                <div
                  key={g.key}
                  className="flex items-center gap-2 bg-white rounded-2xl border border-[#EAE4D6] px-3 py-2.5 shadow-sm"
                >
                  <p className="font-semibold text-[#241E17] flex-1 truncate">{g.name}</p>
                  <button
                    onClick={() => onChangeMin(g.key, g.minStock - 1)}
                    className="w-7 h-7 rounded-full bg-[#F0EBDD] text-[#241E17] font-bold flex items-center justify-center shrink-0"
                  >
                    −
                  </button>
                  <span className="text-sm font-bold w-12 text-center shrink-0">
                    {g.minStock} <span className="text-[10px] font-medium text-[#9C927E]">{g.unit}</span>
                  </span>
                  <button
                    onClick={() => onChangeMin(g.key, g.minStock + 1)}
                    className="w-7 h-7 rounded-full bg-[#F0EBDD] text-[#241E17] font-bold flex items-center justify-center shrink-0"
                  >
                    +
                  </button>
                  <button
                    onClick={() => onToggleEssential(g.key)}
                    className="w-7 h-7 rounded-full bg-[#FBEAE5] text-[#C4432E] flex items-center justify-center shrink-0"
                    aria-label="Sacar de esenciales"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {showQuickAdd ? (
          <QuickAddEssential
            onCancel={() => setShowQuickAdd(false)}
            onAdd={(data) => { onQuickAdd(data); setShowQuickAdd(false); }}
          />
        ) : (
          <button
            onClick={() => setShowQuickAdd(true)}
            className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-[#D8D0BE] text-[#4C7A6C] font-semibold rounded-xl py-3"
          >
            <Plus size={16} /> Agregar esencial nuevo
          </button>
        )}
      </div>
    </div>
  );
}

function QuickAddEssential({ onAdd, onCancel }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [minStock, setMinStock] = useState(1);
  const [unit, setUnit] = useState("un.");

  function submit() {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), category, minStock: Number(minStock), unit });
  }

  return (
    <div className="bg-white rounded-2xl border border-[#EAE4D6] p-3 space-y-2.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ej: Chocolate para cocinar"
        className="w-full bg-[#FBF9F4] border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
        autoFocus
      />
      <div className="grid grid-cols-3 gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="col-span-1 bg-[#FBF9F4] border border-[#EAE4D6] rounded-xl px-2 py-2.5 text-xs outline-none"
        >
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <input
          type="number" min="0"
          value={minStock}
          onChange={(e) => setMinStock(e.target.value)}
          className="bg-[#FBF9F4] border border-[#EAE4D6] rounded-xl px-2 py-2.5 text-sm outline-none text-center"
        />
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          className="bg-[#FBF9F4] border border-[#EAE4D6] rounded-xl px-2 py-2.5 text-xs outline-none"
        >
          {UNITS.map((u) => <option key={u}>{u}</option>)}
        </select>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 text-sm font-semibold text-[#9C927E] py-2">
          Cancelar
        </button>
        <button onClick={submit} className="flex-1 bg-[#1C2B2D] text-[#F7F4EE] font-semibold rounded-xl py-2 text-sm">
          Agregar
        </button>
      </div>
    </div>
  );
}

// ---------- Home ----------
function HomeView({ expiringItems, autoShopping, manualShopping, onMarkBought, onToggleManual, onGoInventory, onGoShopping, displayName }) {
  const uncheckedManual = manualShopping.filter((m) => !m.checked);
  return (
    <div className="space-y-6">
      <section>
        <SectionTitle icon={<AlertTriangle size={16} />} title="Por vencer" />
        {expiringItems.length === 0 ? (
          <EmptyNote text="Nada por vencer en los próximos días." />
        ) : (
          <div className="space-y-2">
            {expiringItems.map((i) => (
              <ExpiryTag key={i.id} item={i} name={displayName(i)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle icon={<ShoppingCart size={16} />} title="Falta comprar" onSeeAll={onGoShopping} />
        {autoShopping.length === 0 && uncheckedManual.length === 0 ? (
          <EmptyNote text="No falta nada por ahora." />
        ) : (
          <div className="space-y-2">
            {autoShopping.map((g) => (
              <ShoppingRow
                key={g.key}
                label={g.name}
                sublabel={`Tenés ${g.totalStock} ${g.unit} · mínimo ${g.minStock}`}
                auto
                onCheck={() => onMarkBought(g.key)}
              />
            ))}
            {uncheckedManual.slice(0, 5).map((m) => (
              <ShoppingRow key={m.id} label={m.name} onCheck={() => onToggleManual(m.id)} />
            ))}
          </div>
        )}
      </section>

      <button
        onClick={onGoInventory}
        className="w-full text-center text-sm font-semibold text-[#4C7A6C] py-3"
      >
        Ver toda la heladera →
      </button>
    </div>
  );
}

function SectionTitle({ icon, title, onSeeAll }) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <div className="flex items-center gap-1.5 text-[#1C2B2D]">
        {icon}
        <h2 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold">
          {title}
        </h2>
      </div>
      {onSeeAll && (
        <button onClick={onSeeAll} className="text-xs font-semibold text-[#847B69]">
          Ver todo
        </button>
      )}
    </div>
  );
}

function EmptyNote({ text }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#D8D0BE] px-4 py-5 text-center text-sm text-[#9C927E]">
      {text}
    </div>
  );
}

function ExpiryTag({ item, name }) {
  const u = urgency(item.days);
  const style = URGENCY_STYLES[u];
  const dayLabel =
    item.days < 0 ? `Hace ${-item.days}d` : item.days === 0 ? "Hoy" : `${item.days}d`;
  return (
    <div className="flex items-center gap-3 bg-white rounded-2xl border border-[#EAE4D6] pl-1 pr-3 py-1 shadow-sm">
      <div
        className="w-14 h-14 rounded-xl flex flex-col items-center justify-center shrink-0"
        style={{ background: style.bg, color: style.text }}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide opacity-80">
          {u === "vencido" ? "vencido" : "vence"}
        </span>
        <span className="text-sm font-extrabold leading-none mt-0.5">{dayLabel}</span>
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-[#241E17] truncate">{name || item.name}</p>
        <p className="text-xs text-[#9C927E]">{item.category}</p>
      </div>
    </div>
  );
}

function ShoppingRow({ label, sublabel, auto, onCheck }) {
  return (
    <button
      onClick={onCheck}
      className="w-full flex items-center gap-3 bg-white rounded-2xl border border-[#EAE4D6] px-3 py-2.5 shadow-sm text-left"
    >
      <span className="w-6 h-6 rounded-full border-2 border-[#D8D0BE] shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[#241E17] truncate">{label}</p>
        {sublabel && <p className="text-xs text-[#9C927E]">{sublabel}</p>}
      </div>
      {auto && (
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-[#F0EBDD] text-[#847B69] shrink-0">
          stock bajo
        </span>
      )}
    </button>
  );
}

// ---------- Inventory ----------
function InventoryView({ items, onAdjust, onEdit, onRemove, onAdd, onScan, displayName, lowStockKeys }) {
  const visibleItems = items.filter((i) => i.stock > 0);
  const hiddenCount = items.length - visibleItems.length;

  const grouped = useMemo(() => {
    const map = {};
    for (const i of visibleItems) {
      map[i.category] = map[i.category] || [];
      map[i.category].push(i);
    }
    return map;
  }, [visibleItems]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold text-[#1C2B2D] flex items-center gap-1.5">
          <Package size={16} /> Inventario
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onScan}
            className="flex items-center gap-1 text-sm font-semibold bg-white border border-[#EAE4D6] text-[#1C2B2D] px-3 py-1.5 rounded-full"
          >
            <ScanLine size={15} /> Escanear
          </button>
          <button
            onClick={onAdd}
            className="flex items-center gap-1 text-sm font-semibold bg-[#1C2B2D] text-[#F7F4EE] px-3 py-1.5 rounded-full"
          >
            <Plus size={15} /> Agregar
          </button>
        </div>
      </div>

      {visibleItems.length === 0 && (
        <EmptyNote
          text={
            items.length === 0
              ? "La heladera está vacía. Agregá algo."
              : "No tenés nada físicamente en la heladera ahora. Lo que falta está en 'Comprar'."
          }
        />
      )}

      {hiddenCount > 0 && visibleItems.length > 0 && (
        <p className="text-xs text-[#9C927E] -mt-2">
          {hiddenCount} esencial{hiddenCount > 1 ? "es" : ""} sin stock — están en "Comprar".
        </p>
      )}

      {Object.entries(grouped).map(([cat, list]) => (
        <div key={cat}>
          <p className="text-xs font-bold uppercase tracking-wide text-[#9C927E] mb-2">{cat}</p>
          <div className="space-y-2">
            {list.map((item) => {
              const days = daysUntil(item.expiry);
              const u = urgency(days);
              const style = URGENCY_STYLES[u];
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-[#EAE4D6] px-3 py-2.5 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-2.5 h-10 rounded-full shrink-0"
                      style={{ background: style.bg }}
                    />
                    <div className="min-w-0 flex-1" onClick={() => onEdit(item)}>
                      <p className="font-semibold text-[#241E17] truncate">{displayName(item)}</p>
                      <p className="text-xs text-[#9C927E]">
                        {item.expiry ? `Vence ${item.expiry}` : "Sin fecha"}
                        {lowStockKeys.has(item.name.trim().toLowerCase()) && (
                          <span className="text-[#C4432E] font-semibold"> · stock bajo</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onAdjust(item.id, -1)}
                        className="w-7 h-7 rounded-full bg-[#F0EBDD] text-[#241E17] font-bold flex items-center justify-center"
                      >
                        −
                      </button>
                      <span className="text-sm font-bold w-10 text-center">
                        {item.stock} <span className="text-[10px] font-medium text-[#9C927E]">{item.unit}</span>
                      </span>
                      <button
                        onClick={() => onAdjust(item.id, 1)}
                        className="w-7 h-7 rounded-full bg-[#F0EBDD] text-[#241E17] font-bold flex items-center justify-center"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 mt-1.5">
                    <button onClick={() => onEdit(item)} className="text-xs font-semibold text-[#4C7A6C]">
                      Editar
                    </button>
                    <button onClick={() => onRemove(item.id)} className="text-xs font-semibold text-[#C4432E]">
                      Eliminar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Cocina ----------
const normalizeIngredientName = (s) => s.trim().toLowerCase();

// ¿Tengo este ingrediente en stock? Comparamos solo por nombre (no cantidad exacta),
// para no meternos en líos de unidades distintas entre la receta y la heladera.
function haveIngredient(items, ingredientName) {
  const key = normalizeIngredientName(ingredientName);
  return items.some((i) => normalizeIngredientName(i.name) === key && i.stock > 0);
}

function CocinaView({ recipes, items, onAdd, onEdit, onRemove }) {
  const [activeTags, setActiveTags] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  const allTags = useMemo(() => {
    const set = new Set();
    recipes.forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [recipes]);

  const recipesWithStatus = useMemo(() => {
    return recipes.map((r) => {
      const missing = (r.ingredients || []).filter((ing) => !haveIngredient(items, ing.name));
      return { ...r, missing, canMake: missing.length === 0 };
    });
  }, [recipes, items]);

  const filtered = recipesWithStatus.filter((r) =>
    activeTags.every((t) => (r.tags || []).includes(t))
  );

  function toggleTag(tag) {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  return (
    <div className="space-y-4">
      <h2 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold text-[#1C2B2D] flex items-center gap-1.5">
        <ChefHat size={16} /> Cocina
      </h2>

      <button
        onClick={onAdd}
        className="w-full flex items-center justify-center gap-1 text-sm font-semibold bg-[#1C2B2D] text-[#F7F4EE] px-3 py-2.5 rounded-2xl"
      >
        <Plus size={15} /> Nueva receta
      </button>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                activeTags.includes(tag)
                  ? "bg-[#4C7A6C] text-white border-[#4C7A6C]"
                  : "bg-white text-[#5B5347] border-[#EAE4D6]"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <EmptyNote
          text={
            recipes.length === 0
              ? "Todavía no cargaste ninguna receta."
              : "Ninguna receta coincide con esos filtros."
          }
          />
        )}

        <div className="space-y-2">
          {filtered.map((r) => {
            const expanded = expandedId === r.id;
            return (
              <div key={r.id} className="bg-white border border-[#EAE4D6] rounded-2xl overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-[#241E17] truncate">{r.name}</p>
                    {r.tags?.length > 0 && (
                      <p className="text-xs text-[#918A7C] truncate">{r.tags.join(" · ")}</p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full ${
                      r.canMake ? "bg-[#E4EEE8] text-[#3A6152]" : "bg-[#F0EBDD] text-[#847B69]"
                    }`}
                  >
                    {r.canMake ? "Podés hacerlo" : `Falta ${r.missing.length}`}
                  </span>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 space-y-3 border-t border-[#EAE4D6] pt-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-[#918A7C] mb-1">Ingredientes</p>
                      <ul className="space-y-1">
                        {(r.ingredients || []).map((ing, idx) => {
                          const missing = !haveIngredient(items, ing.name);
                          return (
                            <li key={idx} className={`text-sm ${missing ? "text-[#C4432E]" : "text-[#241E17]"}`}>
                              {missing ? "✕" : "✓"} {ing.amount ? `${ing.amount} ` : ""}{ing.unit ? `${ing.unit} ` : ""}{ing.name}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    {r.steps?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-[#918A7C] mb-1">Preparación</p>
                        <ol className="space-y-1 list-decimal list-inside">
                          {r.steps.map((step, idx) => (
                            <li key={idx} className="text-sm text-[#241E17]">{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => onEdit(r)}
                        className="flex-1 text-sm font-semibold bg-[#EFEAE0] text-[#1C2B2D] py-2 rounded-xl"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => onRemove(r.id)}
                        className="w-11 flex items-center justify-center bg-[#F7EAE6] text-[#C4432E] rounded-xl"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
  );
}

function RecipeModal({ recipe, onClose, onSave }) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [tagsText, setTagsText] = useState((recipe?.tags || []).join(", "));
  const [ingredients, setIngredients] = useState(
    recipe?.ingredients?.length ? recipe.ingredients : [{ name: "", amount: "", unit: "" }]
  );
  const [stepsText, setStepsText] = useState((recipe?.steps || []).join("\n"));

  function updateIngredient(idx, field, value) {
    setIngredients((prev) => prev.map((ing, i) => (i === idx ? { ...ing, [field]: value } : ing)));
  }
  function addIngredientRow() {
    setIngredients((prev) => [...prev, { name: "", amount: "", unit: "" }]);
  }
  function removeIngredientRow(idx) {
    setIngredients((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleSave() {
    if (!name.trim()) return;
    const cleanIngredients = ingredients
      .map((ing) => ({ ...ing, name: ing.name.trim() }))
      .filter((ing) => ing.name);
    const tags = tagsText
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const steps = stepsText.split("\n").map((s) => s.trim()).filter(Boolean);
    onSave({ name: name.trim(), tags, ingredients: cleanIngredients, steps });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[60]">
      <div className="bg-[#F7F4EE] w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl max-h-[92vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold text-[#1C2B2D]">
            {recipe ? "Editar receta" : "Nueva receta"}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-[#EFEAE0] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>

        <Field label="Nombre">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Tortilla de papas"
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
            autoFocus
          />
        </Field>

        <Field label="Etiquetas (separadas por coma)">
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="Ej: sin gluten, vegetariano"
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
          />
        </Field>

        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[#918A7C] mb-2">Ingredientes</p>
          <div className="space-y-2">
            {ingredients.map((ing, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  value={ing.amount}
                  onChange={(e) => updateIngredient(idx, "amount", e.target.value)}
                  placeholder="Cant."
                  className="w-16 bg-white border border-[#EAE4D6] rounded-xl px-2 py-2 text-sm outline-none focus:border-[#4C7A6C]"
                />
                <input
                  value={ing.unit}
                  onChange={(e) => updateIngredient(idx, "unit", e.target.value)}
                  placeholder="Unidad"
                  className="w-20 bg-white border border-[#EAE4D6] rounded-xl px-2 py-2 text-sm outline-none focus:border-[#4C7A6C]"
                />
                <input
                  value={ing.name}
                  onChange={(e) => updateIngredient(idx, "name", e.target.value)}
                  placeholder="Ingrediente (mismo nombre que en Heladera)"
                  className="flex-1 min-w-0 bg-white border border-[#EAE4D6] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#4C7A6C]"
                />
                <button
                  onClick={() => removeIngredientRow(idx)}
                  className="w-9 shrink-0 flex items-center justify-center bg-[#F7EAE6] text-[#C4432E] rounded-xl"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={addIngredientRow}
            className="mt-2 text-sm font-semibold text-[#4C7A6C] flex items-center gap-1"
          >
            <Plus size={14} /> Agregar ingrediente
          </button>
          <p className="text-xs text-[#918A7C] mt-1">
            Para que la app detecte si te falta o no, escribí el ingrediente con el mismo nombre que usás en Heladera.
          </p>
        </div>

        <Field label="Preparación (un paso por línea)">
          <textarea
            value={stepsText}
            onChange={(e) => setStepsText(e.target.value)}
            placeholder={"Pelar y cortar las papas\nFreír a fuego medio\n..."}
            rows={4}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C] resize-none"
          />
        </Field>

        <button
          onClick={handleSave}
          className="w-full bg-[#1C2B2D] text-[#F7F4EE] font-bold rounded-2xl py-3"
        >
          Guardar receta
        </button>
      </div>
    </div>
  );
}

// ---------- Shopping ----------
function ShoppingView({ autoShopping, manualShopping, newShoppingText, setNewShoppingText, onAddManual, onMarkBought, onToggleManual, onClearChecked, displayName }) {
  const checkedCount = manualShopping.filter((m) => m.checked).length;
  return (
    <div className="space-y-6">
      <h2 style={{ fontFamily: "'Fraunces', serif" }} className="text-lg font-semibold text-[#1C2B2D] flex items-center gap-1.5">
        <ShoppingCart size={16} /> Lista de compras
      </h2>

      <div className="flex gap-2">
        <input
          value={newShoppingText}
          onChange={(e) => setNewShoppingText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAddManual()}
          placeholder="Agregar algo suelto…"
          className="flex-1 bg-white border border-[#EAE4D6] rounded-full px-4 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
        />
        <button
          onClick={onAddManual}
          className="w-11 h-11 rounded-full bg-[#1C2B2D] text-[#F7F4EE] flex items-center justify-center shrink-0"
        >
          <Plus size={18} />
        </button>
      </div>

      {autoShopping.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[#9C927E] mb-2">Stock bajo (automático)</p>
          <div className="space-y-2">
            {autoShopping.map((g) => (
              <ShoppingRow
                key={g.key}
                label={g.name}
                sublabel={`Tenés ${g.totalStock} ${g.unit} · mínimo ${g.minStock}`}
                auto
                onCheck={() => onMarkBought(g.key)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold uppercase tracking-wide text-[#9C927E]">Agregado a mano</p>
          {checkedCount > 0 && (
            <button onClick={onClearChecked} className="text-xs font-semibold text-[#C4432E]">
              Limpiar comprados
            </button>
          )}
        </div>
        {manualShopping.length === 0 ? (
          <EmptyNote text="Nada agregado todavía." />
        ) : (
          <div className="space-y-2">
            {manualShopping.map((m) => (
              <button
                key={m.id}
                onClick={() => onToggleManual(m.id)}
                className="w-full flex items-center gap-3 bg-white rounded-2xl border border-[#EAE4D6] px-3 py-2.5 shadow-sm text-left"
              >
                <span
                  className="w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0"
                  style={{
                    borderColor: m.checked ? "#4C7A6C" : "#D8D0BE",
                    background: m.checked ? "#4C7A6C" : "transparent",
                  }}
                >
                  {m.checked && <Check size={14} color="#fff" />}
                </span>
                <p
                  className={`font-semibold flex-1 truncate ${m.checked ? "line-through text-[#9C927E]" : "text-[#241E17]"}`}
                >
                  {m.name}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Item Modal ----------
// ---------- Buy prompt (pide fecha al marcar comprado) ----------
function BuyPromptModal({ group, onClose, onConfirm }) {
  const suggested = Math.max(1, group.minStock - group.totalStock) || 1;
  const [quantity, setQuantity] = useState(suggested);
  const [expiry, setExpiry] = useState("");

  function submit() {
    onConfirm({ group, quantity: Number(quantity) || 1, expiry: expiry || null });
  }

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-end justify-center z-50" onClick={onClose}>
      <div
        className="bg-[#FBF9F4] w-full max-w-md rounded-t-3xl p-5 pb-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 style={{ fontFamily: "'Fraunces', serif" }} className="text-xl font-semibold text-[#1C2B2D]">
              Compraste {group.name}
            </h3>
            <p className="text-xs text-[#9C927E] mt-0.5">
              Tenías {group.totalStock} {group.unit} · te faltan {suggested} para llegar a {group.minStock}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-[#F0EBDD] flex items-center justify-center shrink-0">
            <X size={16} />
          </button>
        </div>

        <Field label="Cantidad comprada">
          <input
            type="number" min="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
            autoFocus
          />
        </Field>

        <Field label="Vence el (opcional)">
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
          />
        </Field>

        <button
          onClick={submit}
          className="w-full bg-[#4C7A6C] text-white font-bold text-base rounded-2xl py-4 shadow-lg shadow-[#4C7A6C]/30 flex items-center justify-center gap-2 active:scale-[0.98] transition"
        >
          <Check size={20} strokeWidth={3} /> Agregar a la heladera
        </button>
      </div>
    </div>
  );
}

// ---------- Scanner (ZXing) ----------
// Limitamos los formatos a los que usan los productos de supermercado
// (más rápido y más preciso que buscar cualquier tipo de código).
const scannerHints = new Map([
  [
    DecodeHintType.POSSIBLE_FORMATS,
    [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E],
  ],
]);

function ScannerModal({ onClose, onDetected }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | scanning | error
  const [manualCode, setManualCode] = useState("");
  const detectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const reader = new BrowserMultiFormatReader(scannerHints);

    // Forzamos cámara trasera + enfoque continuo: sin esto, el navegador a veces
    // elige la cámara delantera, o enfoca fijo y no logra distinguir códigos de cerca.
    const constraints = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        advanced: [{ focusMode: "continuous" }],
      },
    };

    reader
      .decodeFromConstraints(constraints, videoRef.current, (result, err, controls) => {
        if (cancelled) return;
        controlsRef.current = controls;
        setStatus((s) => (s === "loading" ? "scanning" : s));
        if (result && !detectedRef.current) {
          detectedRef.current = true;
          playBeep();
          controls.stop();
          onDetected(result.getText());
        }
        // los errores de "no encontré nada en este frame" son normales y constantes,
        // no hay que tratarlos como falla real del escáner.
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      try { controlsRef.current?.stop(); } catch {}
    };
  }, []);

  function submitManual() {
    if (!manualCode.trim()) return;
    detectedRef.current = true;
    onDetected(manualCode.trim());
  }

  return (
    <div className="fixed inset-0 bg-black/85 flex flex-col z-50">
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="text-white font-semibold" style={{ fontFamily: "'Fraunces', serif" }}>
          Escanear producto
        </h3>
        <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
          <X size={16} color="#fff" />
        </button>
      </div>

      {status !== "error" && (
        <div className="flex-1 relative overflow-hidden">
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-72 h-32 border-2 border-white/70 rounded-2xl" />
          </div>
          {status === "loading" && (
            <p className="absolute bottom-6 left-0 right-0 text-center text-white text-sm">Iniciando cámara…</p>
          )}
          {status === "scanning" && (
            <p className="absolute bottom-6 left-0 right-0 text-center text-white text-sm">
              Mové el celu despacio hasta enfocar — buena luz y sin muy cerca
            </p>
          )}
        </div>
      )}

      {status === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-4 text-center">
          <Barcode size={40} color="#fff" />
          <p className="text-white text-sm">
            No se pudo acceder a la cámara (puede que falte darle permiso al navegador, o que otra app la esté
            usando). Mientras tanto, escribí el código de barras a mano:
          </p>
          <input
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder="Ej: 7790070418014"
            inputMode="numeric"
            className="w-full bg-white rounded-xl px-3 py-2.5 text-sm outline-none"
            autoFocus
          />
          <button
            onClick={submitManual}
            className="w-full bg-[#4C7A6C] text-white font-bold rounded-2xl py-3"
          >
            Continuar
          </button>
        </div>
      )}
    </div>
  );
}

function ItemModal({ item, prefill, onClose, onSave }) {
  const [name, setName] = useState(item?.name ?? prefill?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? CATEGORIES[0]);
  const [stock, setStock] = useState(item?.stock ?? 1);
  const [minStock, setMinStock] = useState(item?.minStock ?? 1);
  const [unit, setUnit] = useState(item?.unit ?? "un.");
  const [expiry, setExpiry] = useState(item?.expiry ?? "");
  const [essential, setEssential] = useState(item?.essential ?? false);
  const barcode = item?.barcode ?? prefill?.barcode ?? null;

  function currentData() {
    return {
      name: name.trim(),
      category,
      stock: Number(stock),
      minStock: Number(minStock),
      unit,
      expiry: expiry || null,
      essential,
      barcode,
    };
  }
  function submit() {
    if (!name.trim()) return;
    onSave(currentData());
  }
  function handleClose() {
    // si estás editando algo que ya existía, lo que tocaste queda guardado aunque no apretes Guardar
    if (item && name.trim()) onSave(currentData());
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-end justify-center z-50" onClick={handleClose}>
      <div
        className="bg-[#FBF9F4] w-full max-w-md rounded-t-3xl p-5 pb-8 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 style={{ fontFamily: "'Fraunces', serif" }} className="text-xl font-semibold text-[#1C2B2D]">
            {item ? "Editar" : "Agregar"}
          </h3>
          <button onClick={handleClose} className="w-8 h-8 rounded-full bg-[#F0EBDD] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>

        {barcode && (
          <div className="flex items-center gap-2 bg-[#F0EBDD] text-[#847B69] text-xs font-semibold rounded-xl px-3 py-2">
            <Barcode size={14} /> {barcode}
            {prefill && !prefill.name && " · no encontramos el nombre, completalo vos"}
          </div>
        )}

        <Field label="Nombre">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Leche"
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#4C7A6C]"
            autoFocus
          />
        </Field>

        <Field label="Categoría">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
          >
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Stock actual">
            <input
              type="number" min="0"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
            />
          </Field>
          <Field label="Unidad">
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
            >
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Stock mínimo (cuándo avisar que falta)">
          <input
            type="number" min="0"
            value={minStock}
            onChange={(e) => setMinStock(e.target.value)}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
          />
        </Field>

        <Field label="Vence el (opcional)">
          <input
            type="date"
            value={expiry ?? ""}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-full bg-white border border-[#EAE4D6] rounded-xl px-3 py-2.5 text-sm outline-none"
          />
        </Field>

        <button
          type="button"
          onClick={() => setEssential((v) => !v)}
          className="w-full flex items-center justify-between bg-white border border-[#EAE4D6] rounded-xl px-3 py-3"
        >
          <span className="text-sm font-semibold text-[#241E17]">Es esencial (siempre tiene que haber)</span>
          <span
            className="w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0"
            style={{
              borderColor: essential ? "#4C7A6C" : "#D8D0BE",
              background: essential ? "#4C7A6C" : "transparent",
            }}
          >
            {essential && <Check size={14} color="#fff" />}
          </span>
        </button>

        <button
          onClick={submit}
          className="w-full bg-[#4C7A6C] text-white font-bold text-base rounded-2xl py-4 mt-2 shadow-lg shadow-[#4C7A6C]/30 flex items-center justify-center gap-2 active:scale-[0.98] transition"
        >
          <Check size={20} strokeWidth={3} /> Guardar
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-[#847B69] mb-1">{label}</span>
      {children}
    </label>
  );
}

// ---------- Nav ----------
function NavBar({ view, setView, shoppingCount }) {
  const items = [
    { key: "home", label: "Hoy", icon: Home },
    { key: "inventory", label: "Heladera", icon: Package },
    { key: "cocina", label: "Cocina", icon: ChefHat },
    { key: "shopping", label: "Compras", icon: ShoppingCart },
  ];
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#EAE4D6] z-40">
      <div className="max-w-md mx-auto flex">
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className="flex-1 flex flex-col items-center gap-0.5 py-2.5 relative"
            style={{ color: view === key ? "#1C2B2D" : "#B0A895" }}
          >
            <div className="relative">
              <Icon size={20} strokeWidth={view === key ? 2.5 : 2} />
              {key === "shopping" && shoppingCount > 0 && (
                <span className="absolute -top-1.5 -right-2 bg-[#C4432E] text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {shoppingCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-semibold">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
