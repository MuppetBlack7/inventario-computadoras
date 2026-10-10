# Estructura de Firestore y optimización de lecturas

> Documentado desde `firestore.rules`, `firestore.indexes.json` y el código (no se leyó la base real: no hay credenciales de administrador en el entorno).
> Copia de seguridad de reglas, índices y firebase.json: `docs/backup-estructura-2026-10-09/`.

## Colecciones existentes (no se modificaron ni se movieron datos)

| Colección | Uso | Lectura | Escritura |
|---|---|---|---|
| `inventorySessions/{id}` | Sesiones de inventario | Cualquier usuario autenticado | Solo el creador (`ownerId`) |
| `inventoryComputers/{id}` | Equipos | Cualquier usuario autenticado | Solo el creador |
| `users/{uid}/sessions`, `users/{uid}/computers` | Ruta privada anterior (migración) | Solo `uid` | Solo `uid` |

**Sesión:** id, cloudId, name, date, location, ownerId, ownerName, ownerEmail, isExample?, createdAt, updatedAt.
**Equipo:** id, cloudId, sessionId, equipmentType, customEquipmentType, inventoryId, inventoryNormalized, serialNumber, serialNormalized, brand, model, manufacturingYear, yearUnknown, operatingSystem, ramGB, drives[], originalCode, scannedAt, timezone, latitude, longitude, accuracyMeters, writtenLocation, notes, ownerId/Name/Email, photoRemote{fileId,url,filePath,name,size,width,height,mimeType,uploadedAt}, photoStoredLocally, createdAt, updatedAt.
Las fotos **no** se guardan en Firestore (solo la referencia de ImageKit).

**Índices:** ninguno compuesto. Las consultas usadas (`updatedAt` con `orderBy`/`>=`, igualdad en `serialNormalized`/`inventoryNormalized`, conteo) solo necesitan los índices de un campo, que Firestore crea solo.

## Equivalencia con la estructura propuesta (`inventarios`, `sesiones`, `usuarios`)
No se renombraron colecciones: exigiría migrar datos en producción, reescribir reglas y romper a los clientes ya instalados (PWA). Mapeo: `inventorySessions`≈`sesiones`, `inventoryComputers`≈`inventarios`; `tipoEquipo`=`equipmentType`/`customEquipmentType`, `numeroSerie`=`serialNumber`, `modelo`=`model`, `numeroInventario`=`inventoryId`, `fotoUrl`=`photoRemote.url`, `ram`=`ramGB`, `almacenamiento`=`drives`, `sistemaOperativo`=`operatingSystem`, `marca`=`brand`, `año`=`manufacturingYear`, `ubicacion`=`writtenLocation`/lat/lng, `fechaHoraEscaneo`=`scannedAt`, `sesionId`=`sessionId`, `creadoPor`=`ownerId`, `creadoEn`=`createdAt`, `actualizadoEn`=`updatedAt`.

## Estrategia de lecturas
- La app es *offline-first*: IndexedDB local es la caché; la UI nunca lee de Firestore.
- `pullCloudData` baja solo lo modificado desde el último cursor (`where updatedAt >= cursor-10min`, `orderBy`, `limit(200)`, `startAfter`), con consultas simultáneas fusionadas en una.
- Borrados remotos: `getCountFromServer` (1 lectura por cada 1000 docs, máx. cada 10 min); solo si el conteo no cuadra se hace descarga completa.
- La migración de la ruta antigua `users/{uid}` corre una vez por dispositivo/cuenta (antes: 2 lecturas completas por inicio de sesión).
- Sin `onSnapshot`. Caché persistente de Firestore con varias pestañas. Búsqueda local con debounce de 250 ms, lista paginada de 50 en 50, fotos con carga diferida (IntersectionObserver). Excel usa los datos ya cargados (nunca consulta Firestore).

## Lecturas aproximadas (N = documentos totales; K = modificados desde la última sincronización)
| Evento | Antes | Después |
|---|---|---|
| Cada sincronización/guardado/volver a estar en línea | N | ~K + ventana de 10 min (≈0–10) |
| Inicio de sesión | N + 2 colecciones antiguas | ~K (o N la primera vez en el dispositivo) |
| Verificación de borrados | incluida en N | 2 lecturas de conteo cada ≥10 min |
Con N=250 (medido en `src/cloudSync.test.ts`): primera descarga 254, siguientes <40.
