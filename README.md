# La Heladera — beta familiar

App de inventario de heladera/alacena, con datos compartidos en vivo entre todos
los celulares de la familia (vía Firebase), instalable como app (PWA), 100% gratis
para este uso.

## 1. Crear tu proyecto de Firebase (gratis, 5 min)

1. Andá a https://console.firebase.google.com y creá un proyecto nuevo (cualquier nombre).
2. Adentro del proyecto: **Compilación → Firestore Database → Crear base de datos**.
   Elegí "modo de producción" y cualquier región cercana.
3. En **Reglas** de Firestore, pegá esto y publicá (alcanza para una beta familiar
   chica; no requiere login, cualquiera con el link puede leer/escribir — más
   abajo hay una nota de seguridad):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /families/{familyId} {
         allow read, write: if true;
       }
     }
   }
   ```

4. Volvé a la página principal del proyecto → ícono de engranaje ⚙️ → **Configuración
   del proyecto** → bajá hasta "Tus apps" → **Agregar app → Web (`</>`)**.
   Te va a dar un bloque `firebaseConfig` con varias claves.

## 2. Configurar el proyecto

1. Copiá `.env.example` a un archivo nuevo llamado `.env`.
2. Completá cada línea con los valores que te dio Firebase en el paso anterior.
3. En `VITE_FAMILY_CODE`, poné cualquier palabra que quieras (ej: `familia-perez`).
   Es el "código" que va a compartir el mismo inventario entre los 3 celulares.

## 3. Probarlo en tu compu

```bash
npm install
npm run dev
```

Abre la URL que te muestra (típicamente `http://localhost:5173`). Si dos pestañas
del navegador la tienen abierta a la vez, vas a ver los cambios de una reflejarse
en la otra — así se va a comportar entre los celulares de la familia.

## 4. Subir a GitHub

```bash
git init
git add .
git commit -m "La Heladera - beta"
```

Creá un repositorio nuevo (vacío) en https://github.com/new y seguí las
instrucciones que te da para conectarlo (`git remote add origin ...` y
`git push`).

**Importante:** el archivo `.env` con tus claves reales NO se sube (ya está en
`.gitignore`) — solo se sube `.env.example` como plantilla.

## 5. Deploy en Vercel o Netlify (gratis)

Cualquiera de los dos sirve igual:

- **Vercel**: https://vercel.com → "Add New Project" → elegís tu repo de GitHub
  → en "Environment Variables" pegás las mismas variables que tenés en tu `.env`
  local → Deploy.
- **Netlify**: https://netlify.com → "Add new site" → "Import an existing project"
  → tu repo → en "Site settings → Environment variables" pegás lo mismo → Deploy.

Te va a dar una URL fija (tipo `laheladera.vercel.app`). Esa URL no cambia nunca:
cada vez que hagas `git push` con cambios nuevos, se actualiza sola.

## 6. Instalarla en los celulares de tu familia

Mandales la URL. Al abrirla en el celu (Chrome en Android, Safari en iPhone),
va a aparecer la opción "Agregar a la pantalla de inicio" / "Instalar app" —
así queda con ícono propio, sin la barra del navegador.

## Nota de seguridad (leer antes de compartir el link más allá de tu familia)

Las reglas de Firestore de arriba son abiertas (`allow read, write: if true`):
cualquiera que tenga tu link Y adivine tu `FAMILY_CODE` podría ver o modificar
los datos. Para una prueba chica y privada con tu familia es un riesgo bajo,
pero si más adelante la "vendés" a otras familias, hay que sumar autenticación
de usuarios antes — eso lo vemos en la fase de servidor "posta".
