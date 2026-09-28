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

## Chạy local trong 5 phút

1. Clone repo và vào thư mục:

   ```bash
   git clone <repo-url> veyrigate && cd veyrigate
   ```

2. Sao chép `.env.example` cho từng package (không commit `.env`):

   ```bash
   # macOS / Linux
   cp be/.env.example be/.env
   cp fe-admin/.env.example fe-admin/.env
   cp fe-sso-test/.env.example fe-sso-test/.env
   ```

   ```powershell
   # Windows (PowerShell)
   Copy-Item be\.env.example be\.env
   Copy-Item fe-admin\.env.example fe-admin\.env
   Copy-Item fe-sso-test\.env.example fe-sso-test\.env
   ```

   ```bat
   :: Windows (cmd)
   copy be\.env.example be\.env
   copy fe-admin\.env.example fe-admin\.env
   copy fe-sso-test\.env.example fe-sso-test\.env
   ```

3. Cài dependency + khởi động hạ tầng + chạy app:

   ```bash
   pnpm i                 # cài dependency toàn workspace
   docker compose up -d   # khởi động mongo, redis, mailpit
   pnpm dev:all           # chạy song song 3 app (khi đã scaffold)
   ```

## Secret scan (pre-commit)

Repo dùng [gitleaks](https://github.com/zricethezav/gitleaks) qua `pre-commit` để chặn commit chứa secret (`.pre-commit-config.yaml`).

```bash
pip install pre-commit
pre-commit install        # cài git hook một lần
pre-commit run gitleaks --all-files   # quét thủ công toàn repo
```

Chỉ commit `.env.example` (placeholder). `.env` / `.env.local` bị `.gitignore` loại và không được commit.

### Hạ tầng dev (docker-compose)

`docker compose up -d` khởi động `mongo`, `redis`, `mailpit`. Kiểm tra healthcheck:

```bash
docker compose ps      # chờ mongo/redis ở trạng thái "healthy"
```

Service `be` nằm trong profile `full` (mặc định không chạy) và cần `be/Dockerfile` (task B7.3):

```bash
docker compose --profile full up -d
```

## Agent workspace

Layout thực tế của quy trình agile-agent (khác đường dẫn nêu trong `plan.md` §4):

| Thành phần | Vị trí thực tế |
|---|---|
| Agents (7) | `.github/agents/*.agent.md` (analyst, tech-lead, backend-dev, frontend-dev, senior-reviewer, tester, orchestrator) + `HANDOFF-PROTOCOL.md` |
| Spec / plan | `docs/agile/<slug>/spec.md` + `plan.md` (mỗi tính năng một thư mục theo `<slug>`) |
| Progress / handoff | `docs/agile/<slug>/_progress.md` + `_handoff.md` |

Mỗi agent đọc spec trong thư mục tính năng (`docs/agile/<slug>/`) trước khi làm; không dùng `docs/spec.md` hay root `PROGRESS.md`.
