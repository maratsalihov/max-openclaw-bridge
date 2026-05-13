# MAX.ru ↔ OpenClaw Bridge

> Bridge between [MAX.ru](https://max.ru) messenger and [OpenClaw](https://openclaw.ai) AI assistant. Chat with your AI assistant directly from the MAX app on any device.

**English** | [Русский](#русский)

---

## Features

- **Thread-based sessions** — each user gets `max:userId:thread-NNN` sessions in OpenClaw
- **Auto new thread** — creates a fresh thread after configurable inactivity period (default: 30 min)
- **State persistence** — threads survive bridge restarts via `max-threads.json`
- **Streaming** — receives OpenClaw responses as a stream
- **Typing indicator** — shows "typing..." in MAX while AI is thinking
- **Tool status** — logs active tools (search, browser, file ops) to console
- **Multi-user** — supports multiple MAX users with separate sessions

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- OpenClaw gateway running (`openclaw gateway run`)
- MAX developer account with API token

## Setup

### 1. Get MAX API token

Register at [max.ru/developers](https://max.ru/developers) and create a bot/app to get your API token.

### 2. Get your MAX user ID

The bridge uses `user_id` from MAX API (not username). You can find it:
- In the MAX app developer tools
- From the first update response when you message your bot

### 3. Install and configure

```bash
git clone https://github.com/yourusername/max-openclaw-bridge.git
cd max-openclaw-bridge
npm install
cp .env.example .env
```

Edit `.env`:

```env
# Required
MAX_TOKEN=your_max_api_token_here
ALLOWED_USER_IDS=12345678,87654321

# Optional — defaults below
OC_GATEWAY_HOST=127.0.0.1
OC_GATEWAY_PORT=18789
OC_TOKEN=your_openclaw_gateway_token_here
THREAD_TIMEOUT_MINUTES=30
```

**How to find OpenClaw gateway token:**
```bash
cat ~/.openclaw/openclaw.json | jq -r '.gateway.auth.token'
```

The bridge will auto-detect it if `OC_TOKEN` is not set.

### 4. Run

```bash
node max-bridge.js
```

### 5. Message your MAX bot

Open MAX, send a message to your bot — it will be forwarded to OpenClaw and the reply will come back.

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAX_TOKEN` | ✅ | — | MAX API token from max.ru/developers |
| `ALLOWED_USER_IDS` | ✅ | — | Comma-separated user IDs allowed to use the bridge |
| `OC_GATEWAY_HOST` | | `127.0.0.1` | OpenClaw gateway host |
| `OC_GATEWAY_PORT` | | `18789` | OpenClaw gateway port |
| `OC_TOKEN` | | auto-detect | OpenClaw gateway auth token |
| `THREAD_TIMEOUT_MINUTES` | | `30` | Inactivity minutes before creating new thread |

## MAX API Reference

The bridge uses the MAX Platform API:

- **Base URL:** `https://platform-api.max.ru`
- **Auth:** `Authorization: <MAX_TOKEN>` header
- **Long Polling:** `GET /updates?timeout=20&limit=10&marker=<marker>`
- **Send message:** `POST /messages?user_id=<id>` with body `{ "text": "..." }`
- **Typing indicator:** `POST /chats/{user_id}/actions` with `{ "action": "typing_on" }`

See official docs at [max.ru/developers](https://max.ru/developers) for full API details.

## PM2 (production)

```bash
npm install -g pm2
pm2 start max-bridge.js --name max-bridge
pm2 save
pm2 startup
```

## License

MIT

---

# Русский

## Описание

Мост между мессенджером [MAX.ru](https://max.ru) и AI-ассистентом [OpenClaw](https://openclaw.ai). Общайтесь с AI-ассистентом прямо из приложения MAX на любом устройстве.

## Возможности

- **Thread-сессии** — каждый пользователь получает сессию `max:userId:thread-NNN` в OpenClaw
- **Автоматический новый thread** — создаётся после заданного периода бездействия (по умолчанию: 30 мин)
- **Сохранение состояния** — threads сохраняются между перезапусками в `max-threads.json`
- **Streaming** — ответы приходят потоком
- **Индикатор печати** — показывает "печатает..." в MAX пока AI думает
- **Статус инструментов** — логирует активные инструменты в консоль
- **Мульти-пользователь** — поддержка нескольких пользователей MAX с раздельными сессиями

## Требования

- [Node.js](https://nodejs.org/) 18+
- OpenClaw gateway запущен (`openclaw gateway run`)
- Аккаунт разработчика MAX с API-токеном

## Установка

### 1. Получите токен MAX API

Зарегистрируйтесь на [max.ru/developers](https://max.ru/developers) и создайте бота/приложение.

### 2. Узнайте свой MAX user ID

Мост использует `user_id` из API MAX. Найти его можно:
- В инструментах разработчика MAX
- Из первого ответа updates после сообщения боту

### 3. Установка

```bash
git clone https://github.com/yourusername/max-openclaw-bridge.git
cd max-openclaw-bridge
npm install
cp .env.example .env
```

Отредактируйте `.env`:

```env
# Обязательно
MAX_TOKEN=ваш_токен_max_здесь
ALLOWED_USER_IDS=12345678

# Опционально — значения по умолчанию указаны ниже
OC_GATEWAY_HOST=127.0.0.1
OC_GATEWAY_PORT=18789
OC_TOKEN=ваш_openclaw_токен_здесь
THREAD_TIMEOUT_MINUTES=30
```

**Как найти токен OpenClaw gateway:**
```bash
cat ~/.openclaw/openclaw.json | jq -r '.gateway.auth.token'
```

Мост определит токен автоматически, если `OC_TOKEN` не задан.

### 4. Запуск

```bash
node max-bridge.js
```

### 5. Напишите боту в MAX

Откройте MAX, отправьте сообщение боту — оно будет перенаправлено в OpenClaw, а ответ вернётся в MAX.

## Справочник переменных

| Переменная | Обязательно | По умолчанию | Описание |
|------------|-------------|--------------|----------|
| `MAX_TOKEN` | ✅ | — | Токен MAX API |
| `ALLOWED_USER_IDS` | ✅ | — | ID пользователей через запятую |
| `OC_GATEWAY_HOST` | | `127.0.0.1` | Хост OpenClaw gateway |
| `OC_GATEWAY_PORT` | | `18789` | Порт OpenClaw gateway |
| `OC_TOKEN` | | авто | Токен авторизации OpenClaw |
| `THREAD_TIMEOUT_MINUTES` | | `30` | Минут бездействия до нового thread |

## Справочник MAX API

Мост использует MAX Platform API:

- **Базовый URL:** `https://platform-api.max.ru`
- **Авторизация:** заголовок `Authorization: <MAX_TOKEN>`
- **Long Polling:** `GET /updates?timeout=20&limit=10&marker=<marker>`
- **Отправка:** `POST /messages?user_id=<id>` с телом `{ "text": "..." }`
- **Печатает:** `POST /chats/{user_id}/actions` с `{ "action": "typing_on" }`

Полная документация: [max.ru/developers](https://max.ru/developers)

## PM2 (продакшен)

```bash
npm install -g pm2
pm2 start max-bridge.js --name max-bridge
pm2 save
pm2 startup
```

## Лицензия

MIT