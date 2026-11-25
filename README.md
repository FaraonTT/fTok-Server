# fTok-Server

Сервер для приложения **fTok** из [fOS Simulator](https://github.com/FaraonTT/fOS-Simulator). Node 22, без зависимостей.
Видео и индекс хранятся в ветке `storage` этого репозитория. **Секрет — только `GH_TOKEN`.**

## Токен
GitHub → Settings → Developer settings → Fine-grained tokens: доступ **только к этому репозиторию**, `Contents: Read and write`.

## Запуск
- Локально / VPS: `GH_TOKEN=... node server.js` или `docker build -t ftok . && docker run -e GH_TOKEN=... -p 8080:8080 ftok`
- Codespaces: добавьте секрет `GH_TOKEN` в Settings → Secrets → Codespaces, откройте Codespace — сервер стартует сам; порт 8080 сделайте Public и вставьте его URL в fTok → Профиль.
- Любой хостинг контейнеров (Fly.io, Render, Railway): Dockerfile + переменная `GH_TOKEN`.

> GitHub не умеет постоянно хостить серверы: Codespace засыпает. Для работы 24/7 используйте VPS или хостинг контейнеров.

## Переменные
`GH_TOKEN` (обяз.), `GH_REPO`, `GH_BRANCH` (storage), `UPLOAD_KEY` (если задан — загрузка требует заголовок `x-upload-key`), `PORT`.

## API
`GET /api/videos?q=&user=&limit=` · `POST /api/videos?user=&title=` (тело — mp4, ≤50 МБ) · `POST /api/videos/:id/like` · `GET /v/:id` (Range) · `GET /health`

Хранилище на GitHub подходит для небольшого проекта (лимиты API и размера репозитория).
