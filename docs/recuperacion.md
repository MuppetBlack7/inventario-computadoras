# Diagnóstico de recuperación

La versión con diagnóstico lee IndexedDB y consulta directamente las colecciones compartidas de Firestore antes de permitir la sincronización normal. Si hay datos locales sin correspondencia exacta, operaciones pendientes, fotografías por subir, diferencias o Firestore no responde, mantiene detenida la sincronización. La migración automática de las rutas heredadas tampoco se ejecuta al iniciar sesión.

## En el teléfono

1. Antes de abrir una versión nueva, conserva el JSON original que importaste y cualquier respaldo anterior. No borres los datos del sitio ni desinstales la PWA.
2. Abre la aplicación e inicia sesión con la cuenta habitual. Espera el diagnóstico. Si aparece «Recuperación pendiente», ninguna acción de ese panel ejecuta escrituras de inventario.
3. Pulsa «Descargar copia y SHA-256». Guarda **ambos archivos** y anota el SHA-256 mostrado. La copia contiene los registros y la cola de este navegador, fotografías locales en base64 y una instantánea de Firestore si respondió. Trátala como información privada.
4. Repite el proceso en cada navegador o perfil donde hayas usado la aplicación. Conserva las copias separadas e identifica el dispositivo y la cuenta utilizados. El origen y el agente de usuario del informe ayudan a describir el navegador, pero no constituyen una identidad única.
5. Revisa las filas «Posible duplicado», «Cambios diferentes», «Propietario no confirmado o distinto», «Foto pendiente» y «Cola pendiente». No vuelvas a importar el JSON ni ejecutes la sincronización antigua.
6. Comparte para revisión las copias y el JSON original mediante un canal privado. Comprueba el SHA-256 del JSON descargado antes de cualquier corrección.

Si el diagnóstico no encuentra datos locales pendientes ni diferencias y el servidor respondió, la pantalla permite autorizar expresamente la sincronización normal después de guardar la copia. Cuando hay cualquier operación pendiente o conflicto, no aparece esa opción: se necesita una resolución por registro.

## Estado de ejecución

El plan es deliberadamente de solo lectura. Las filas «crear tras revisión» son propuestas, no instrucciones ejecutables. Para habilitar escrituras hace falta una etapa adicional que capture una revisión base remota y local, vuelva a leer ambas inmediatamente antes de escribir, detenga conflictos, verifique cada escritura y su foto, y reanude la cola sin borrar ni duplicar operaciones. La ruta actual de `setDoc` no cuenta con todas esas garantías.

La presencia de una referencia `photoRemote` no prueba que el archivo todavía exista en ImageKit. El diagnóstico solo compara referencias; la comprobación de disponibilidad del archivo requiere una consulta autorizada posterior. Las pruebas automáticas usan datos simulados y no comprueban los datos de tu teléfono.
