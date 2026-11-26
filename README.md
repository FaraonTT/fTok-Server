# fTok-Server

Сервер для приложения **fTok** из [fOS Simulator](https://github.com/FaraonTT/fOS-Simulator). Node 22, без зависимостей.
Видео, индекс и аккаунты хранятся в ветке `storage` репозитория `GH_REPO`. **Секрет — только `GH_TOKEN`.**

## Как приложение находит сервер
Приложение читает адрес из файла [`server.json`](server.json) в этом репозитории (`{"url": "https://ваш-сервер"}`).
Запустили сервер → вписали его URL в `server.json` → пользователям ничего вводить не нужно, только имя и пароль аккаунта.

## Аккаунты
Регистрация и вход по имени и паролю (`POST /api/register`, `/api/login`). Пароли хранятся хэшем (scrypt + соль), сессия — подписанный токен на 30 дней. Загрузка видео и лайки требуют входа.

> **Важно:** хэши паролей лежат в `users.json` ветки `storage`. Если репозиторий публичный, их видит каждый. Для боевого использования создайте **приватный** репозиторий данных и укажите его в `GH_REPO` (этот репозиторий оставьте публичным ради `server.json`).

## Токен
GitHub → Settings → Developer settings → Fine-grained tokens: доступ **только к репозиторию данных**, `Contents: Read and write`.

## Запуск
- Локально / VPS: `GH_TOKEN=... node server.js` или `docker build -t ftok . && docker run -e GH_TOKEN=... -p 8080:8080 ftok`
- Codespaces: секрет `GH_TOKEN` в Settings → Secrets → Codespaces; порт 8080 сделайте Public.
- Хостинг контейнеров (Fly.io, Render, Railway): Dockerfile + переменная `GH_TOKEN`.

> GitHub не умеет постоянно хостить серверы: Codespace засыпает. Для 24/7 нужен VPS или хостинг контейнеров.

## Переменные
`GH_TOKEN` (обяз.), `GH_REPO`, `GH_BRANCH` (storage), `PORT`.

## API
`POST /api/register` · `POST /api/login` · `GET /api/videos?q=&user=&limit=` · `POST /api/videos?title=` (Bearer-токен, тело — mp4 ≤50 МБ) · `POST /api/videos/:id/like` (Bearer) · `GET /v/:id` (Range) · `GET /health`

Хранилище на GitHub подходит для небольшого проекта (лимиты API и размера репозитория).
