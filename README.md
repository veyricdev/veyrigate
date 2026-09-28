# sso-idp

OIDC/OAuth2 Identity Provider — pnpm monorepo.

Nguồn sự thật: [`docs/agile/sso-idp/spec.md`](docs/agile/sso-idp/spec.md) và [`docs/agile/sso-idp/plan.md`](docs/agile/sso-idp/plan.md).

## Cấu trúc

| Package | Mô tả | Scaffold tại |
|---|---|---|
| `be/` | NestJS + Fastify IdP | B1.1 |
| `fe-admin/` | TanStack Start — trang quản trị | A1 |
| `fe-sso-test/` | Vite + React + React Router — app thử SSO (public client) | T1 |

Các package hiện là **placeholder** (chỉ có `package.json` + script placeholder) để workspace nhận diện; scaffold thực hiện ở các task nêu trên.

## Cổng dev (plan §1.2)

| Thành phần | URL |
|---|---|
| BE (IdP) | `http://localhost:4000` (`ISSUER`) |
| fe-admin | `http://localhost:3000` |
| fe-sso-test | `http://localhost:5173` |
| MongoDB | `mongodb://localhost:27017` |
| Redis | `redis://localhost:6379` |
| Mailpit | SMTP `1025`, UI `http://localhost:8025` |

## Yêu cầu

- Node `v22.23.2` (xem `.nvmrc` / `.node-version`)
- pnpm (bật qua `corepack enable`)
- Docker (cho hạ tầng dev: mongo, redis, mailpit)

## Chạy nhanh

```bash
pnpm i                 # cài dependency toàn workspace
docker compose up -d   # khởi động mongo, redis, mailpit
pnpm dev:all           # chạy song song 3 app (khi đã scaffold)
```

### Hạ tầng dev (docker-compose)

`docker compose up -d` khởi động `mongo`, `redis`, `mailpit`. Kiểm tra healthcheck:

```bash
docker compose ps      # chờ mongo/redis ở trạng thái "healthy"
```

Service `be` nằm trong profile `full` (mặc định không chạy) và cần `be/Dockerfile` (task B7.3):

```bash
docker compose --profile full up -d
```
