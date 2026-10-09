# Inventario de computadoras — PWA con Firebase

Aplicación en español para iPhone, iPad y escritorio. Cualquier cuenta de Google autenticada ve el mismo inventario compartido y puede agregar registros. IndexedDB conserva el trabajo sin conexión; cada registro mantiene su creador y solo ese usuario puede editarlo o eliminarlo.

## Instalar y arrancar

```powershell
cd "C:\Users\ramon\Documents\Codex\2026-10-09\act-a-como-desarrollador-y-utiliza\outputs\inventario-computadoras"
npm install
npm run generate:icons
npm run build
npm run preview
```

En la PC abre `http://localhost:4173`.

Producción Firebase HTTPS: <https://inventario-computadoras-rc26.web.app>

## Abrir desde iPhone o iPad con HTTPS

La forma preparada usa un túnel HTTPS temporal. PC e iPhone necesitan Internet mientras se realiza la primera carga:

```powershell
winget install -e --id Cloudflare.cloudflared
npm run ios
```

El comando muestra una dirección `https://...trycloudflare.com`. Ábrela en Safari, toca **Compartir → Agregar a pantalla de inicio** y abre la aplicación una vez. Mantén la ventana de PowerShell abierta durante el acceso; la URL cambia al reiniciar el túnel. Tras la primera carga, la PWA y los datos ya guardados pueden funcionar sin conexión.

También puede usarse la URL de Firebase Hosting indicada al final de la configuración. En Safari toca **Compartir → Agregar a pantalla de inicio**. Descarga respaldos con frecuencia porque iOS puede borrar almacenamiento web.

## Firebase

El proyecto exclusivo es `inventario-computadoras-rc26` (nombre visible: `inventario-computadoras`). La configuración real vive en `.env.local` y no se versiona. `.env.example` documenta las variables públicas necesarias. La CLI se ejecuta localmente, sin instalación global:

```powershell
npx firebase-tools login --no-localhost
npx firebase-tools use
npm run test:rules:emulator
npm run build
```

Antes de desplegar, confirma que `npx firebase-tools use` muestra exclusivamente el proyecto de esta aplicación. `firestore.rules` exige Google Sign-In, permite lectura compartida y creación a cualquier usuario autenticado, y restringe edición/eliminación al creador.

Cloud Storage no se usa y `VITE_FIREBASE_STORAGE_ENABLED=false`. No se habilitó facturación ni se modificó el plan de Firebase.

### ImageKit protegido

La integración usa `worker/src/index.ts` en Cloudflare Workers Free: valida el ID token de Firebase, comprueba autoría para subir/reemplazar/eliminar, limita imágenes a JPEG/PNG/WebP y 5 MB, sube archivos privados y entrega URL firmadas de cinco minutos a cualquier usuario autenticado. Firestore guarda solo `fileId`, URL, ruta y metadatos. El frontend nunca recibe la clave privada.

Configuración segura:

1. Usar la cuenta gratuita de ImageKit. El endpoint público está en `worker/wrangler.jsonc`.
2. Revocar cualquier clave expuesta y crear una **Private Key nueva** con los permisos mínimos necesarios para cargar y eliminar archivos.
3. Autorizar Wrangler y guardar la clave solo mediante su prompt secreto. No pegarla en el chat ni en archivos:

```powershell
cd worker
npx wrangler login --device
npx wrangler secret put IMAGEKIT_PRIVATE_KEY
npm run check
npm run deploy
```

4. Guardar la URL `https://inventario-computadoras-imagekit.<subdominio>.workers.dev` en `VITE_IMAGEKIT_BACKEND_URL` dentro de `.env.local`, compilar y desplegar Hosting. Hasta completar la prueba en producción, las fotos permanecen en IndexedDB y la aplicación ofrece migrarlas sin borrar los originales.

Esta ruta no usa Firebase Functions, Firebase Storage ni el plan Blaze.

## Despliegue en Vercel

Importa el repositorio en Vercel como proyecto Vite y configura estas variables para Production, Preview y Development:

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_STORAGE_ENABLED
VITE_IMAGEKIT_BACKEND_URL
```

En Vercel, `VITE_FIREBASE_AUTH_DOMAIN` debe ser el dominio de producción de Vercel. `vercel.json` reenvía `/__/auth/*` al manejador de Firebase para que `signInWithRedirect` conserve la sesión en Safari. Ese dominio también debe estar en **Firebase Authentication → Settings → Authorized domains** y su URL `/__/auth/handler` en los URI de redirección autorizados del cliente OAuth de Google. La clave privada de ImageKit permanece exclusivamente en el secreto `IMAGEKIT_PRIVATE_KEY` del Worker; nunca es una variable de Vercel.

Despliegue manual:

```powershell
npx vercel login
npx vercel link
npx vercel --prod
```

Para permitir cuentas externas, el código no aplica dominios ni listas de correos. Si Google Auth Platform muestra la audiencia como **Interna** o el estado **Prueba**, abre Google Cloud Console → Google Auth Platform → Audience, selecciona **Externa** y publica la aplicación. Este cambio requiere confirmación del propietario del proyecto.

## Pantallas

- **Sesiones:** crea jornadas por nombre, fecha y ubicación; muestra totales.
- **Inventario:** busca por serie, identificador, marca o modelo.
- **Escanear:** lee QR/códigos con cámara o acepta captura manual; solicita GPS y detecta duplicados.
- **Detalle/edición:** fotografía, especificaciones, varias unidades, ubicación, precisión y observaciones.
- **Respaldo:** Excel con miniaturas y exactamente ocho columnas (`Tipo de equipo`, `Número de serie`, `Modelo`, `Número de inventario`, `Foto`, `RAM`, `Unidades`, `Sistema operativo`), además de respaldo JSON completo y restauración.

El botón **Cargar datos de ejemplo** crea una sesión marcada como ejemplo. En **Respaldo** se incluye un QR estructurado descargable para probar el escáner.

## Comprobación

```powershell
npm run check
npm run test:rules:emulator
npm audit --omit=dev
```

La cámara, Google Sign-In, los permisos de ubicación, la instalación desde Safari y el comportamiento del almacenamiento bajo iOS deben comprobarse finalmente en un iPhone/iPad real.
