# EmailBot Backend

API RESTful para EmailBot - Servicio de procesamiento de emails, generación de drafts con AI y gestión de leads.

---

## 🚀 Descripción

Backend Node.js/Express que provee:
- **Ingesta de emails** desde Gmail API
- **Generación de drafts** con Gemini AI
- **Gestión de leads** sincronizada con Notion
- **Seguimiento de emails** (threads)
- **Métricas y monitoreo** en tiempo real

---

## 📁 Estructura del Proyecto

```
emailbot-backend/
├── server-new.js           # Servidor principal (Express)
├── server-simple.js        # Versión simplificada (legacy)
├── server.js               # Entry point
├── cli.js                  # CLI para operaciones manuales
├── migrate.js              # Scripts de migración de DB
├── config/
│   └── default.json        # Configuración por defecto
├── src/
│   ├── drafter.js          # Lógica de generación de drafts
│   ├── gmail-client.js     # Cliente Gmail API
│   ├── notion-client.js    # Cliente Notion API
│   └── db.js               # Conexión PostgreSQL
├── scripts/
│   └── cron-ingest.js      # Job de ingesta periódica
├── docs/
│   ├── LANGUAGE_FIX_SUMMARY.md
│   ├── WORKLOG_2026-02-15.md
│   └── system_prompt_v3.md
└── __tests__/
    └── *.test.js           # Tests unitarios
```

---

## ⚙️ Variables de Entorno

### Requeridas

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `DATABASE_URL` | URL de PostgreSQL | `postgresql://user:pass@host:5432/dbname` |
| `GMAIL_USER` | Email de Gmail | `hello@mdx.so` |
| `GOOGLE_CLIENT_ID` | OAuth2 Client ID | `348032879976-xxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth2 Secret | `GOCSPX-xxx` |
| `GOOGLE_REFRESH_TOKEN` | Token de refresco OAuth2 | `1//04xxx` |
| `GEMINI_API_KEY` | API Key de Google AI | `AIzaSyCxxx` |

### Opcionales

| Variable | Descripción | Default |
|----------|-------------|---------|
| `NOTION_API_KEY` | Token de integración Notion | - |
| `NOTION_LEADS_DB_ID` | ID de base de datos de leads | - |
| `NOTION_FOLLOWUPS_DB_ID` | ID de base de seguimientos | - |
| `PORT` | Puerto del servidor | `3001` |
| `NODE_ENV` | Entorno | `development` |
| `API_SECRET` | Secret para autenticación interna | - |

---

## 🔌 API Endpoints

### Health Check
```
GET /health
```
**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-21T15:00:00.000Z"
}
```

### Emails
```
GET /api/emails
GET /api/emails/:id
GET /api/emails/:id/thread
POST /api/emails/:id/generate-draft
POST /api/emails/:id/remind
```

### Drafts
```
GET /api/drafts
GET /api/drafts/:id
POST /api/drafts/:id/approve
POST /api/drafts/:id/reject
POST /api/drafts/:id/regenerate
POST /api/drafts/:id/send
```

### Leads
```
GET /api/leads
GET /api/leads/:id
```

### Threads
```
GET /api/threads/:id
```

### Métricas
```
GET /api/metrics
```

---

## 🛠️ Instalación Local

```bash
# Clonar repositorio
git clone https://github.com/Mdx2025/emailbot-backend.git
cd emailbot-backend

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Ejecutar migraciones
node migrate.js

# Iniciar servidor
npm start
```

---

## 🚢 Deploy en Railway

```bash
# Instalar CLI de Railway
npm install -g @railway/cli

# Login
railway login

# Enlazar proyecto
railway link

# Configurar variables
railway variables set DATABASE_URL="postgresql://..."
railway variables set GMAIL_USER="hello@mdx.so"
# ... etc

# Deploy
railway up
```

---

## 🤖 Integración con AI

El backend usa **Google Gemini** para generar drafts personalizados:

- **Modelo actual:** `gemini-2.5-flash`
- **Detección de idioma:** Automática (ES/EN)
- **Fallback:** Respuestas predefinidas por idioma

### Prompt del Sistema

Ver `docs/system_prompt_v3.md` para el prompt completo usado por Gemini.

---

## 📊 Base de Datos

### Tablas Principales

| Tabla | Descripción |
|-------|-------------|
| `emails` | Emails ingestados desde Gmail |
| `drafts` | Drafts generados por AI |
| `leads` | Leads desde formularios Notion |
| `activity` | Log de actividad del sistema |

### Conexión

```javascript
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
```

---

## 🔒 Seguridad

- **Autenticación:** OAuth2 para Gmail API
- **Autorización interna:** Header `X-API-Secret` para frontend
- **CORS:** Configurado para dominios específicos
- **Rate Limiting:** Implementado en endpoints sensibles

---

## 📈 Monitoreo

- **Logs:** Winston con niveles (error, warn, info, debug)
- **Métricas:** Endpoint `/api/metrics` con estadísticas
- **Health:** Endpoint `/health` para checks

---

## 🧪 Testing

```bash
# Tests unitarios
npm test

# Tests con cobertura
npm run test:coverage

# Linting
npm run lint
```

---

## 📝 Changelog Reciente

| Fecha | Cambio |
|-------|--------|
| 2026-02-21 | Fix: Modelo Gemini actualizado a `gemini-2.5-flash` |
| 2026-02-21 | Fix: Manejo de drafts corruptos en PostgreSQL |
| 2026-02-20 | Fix: Detección de idioma automática (ES/EN) |
| 2026-02-19 | Feature: Endpoint de regeneración de drafts |
| 2026-02-18 | Fix: Validación de modelo Gemini antes de usar |

---

## 🔗 Links Relacionados

- **Frontend:** https://github.com/Mdx2025/emailbot
- **Dashboard:** https://emailbot-production-83f9.up.railway.app/
- **Backend Deploy:** https://emailbot-backend-v2-production.up.railway.app/

---

## 👥 Autores

- **MDX** - Diseño y desarrollo

---

## 📄 Licencia

Proprietary - MDX 2026
