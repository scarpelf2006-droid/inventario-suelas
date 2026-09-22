# Inventario de suelas

Programa web para llevar el inventario de suelas: fotos, pedidos con llegadas parciales, faltantes/sobrantes, total a pagar y fecha de cada llegada.

Funciona en internet las 24 horas sin necesidad de tener un computador encendido: los datos se guardan en una base de datos en Supabase (gratis) y las fotos en Cloudinary (gratis).

## Variables de entorno necesarias
- `DATABASE_URL`: la conexión a tu base de datos de Supabase.
- `CLOUDINARY_CLOUD_NAME` y `CLOUDINARY_UPLOAD_PRESET`: tu cuenta de Cloudinary, para subir las fotos.
- `APP_PASSWORD`: contraseña para entrar al programa (obligatoria si está publicado en internet).

## Cómo correrlo en tu PC (para probar)
```bash
npm install
DATABASE_URL="..." CLOUDINARY_CLOUD_NAME="..." CLOUDINARY_UPLOAD_PRESET="..." APP_PASSWORD="..." npm start
```
Abre http://localhost:3000.

## Publicarlo en internet
Ver la guía paso a paso que se entregó junto con este proyecto (Supabase + Cloudinary + Render).
