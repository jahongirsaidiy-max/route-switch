# route-switch — kod qoidalari va gate'lar

Bu fayl `route-switch/` ichidagi fayllar bilan ishlaganda yuklanadi. Umumiy
qoidalar (scope, branch, QA'siz commit yo'q, trailer taqiqi, tizimga tegish
qoidasi) — workspace root `CLAUDE.md` da.

> 🔴 Bu repo **public**. Sir, sertifikat, real ichki IP/domen, ichki eslatma
> tushmaydi. Namuna ma'lumotlar umumiy: `10.0.0.0/8`, `corp.local`.

## Code quality

- No `any` types unless unavoidable and commented with a reason.
- No `TODO` comments in completed code — if it's unfinished, the task is not done.
- No hardcoded values that belong in config; yo'llar (`/var/run/routeswitch.sock`,
  `/Library/…`) bitta konstantalar modulida.
- Error paths must be handled — no silent swallows. IPC xatosi:
  `{ id, ok: false, error }`; qoida xatosi: `EngineState` da `error` + sabab.
- **Shell yo'q:** faqat `execFile` + absolyut yo'l, argumentlar massiv. `exec`,
  `execSync`, `shell: true`, buyruqni string qilib yig'ish — taqiqlangan.
- **Paket chegaralari:** `shared` hech kimga bog'lanmaydi; `helper` va `app`
  faqat `shared` ga; `app` ↔ `helper` importi yo'q (faqat socket).
- **Renderer** Node API'ga tegmaydi — faqat `window.rs` (preload).
- Device nomi (`en5`) qotirilmaydi — rol (`ethernet`/`wifi`) → `netinfo`.
- Tur/schema nusxasi ko'chirilmaydi — `packages/shared` dan import.

---

## Verification gates (Builder before handoff, QA during review)

All must pass. Any failure means the task is not done. Buyruqlar repo ildizida
(`route-switch/`); skriptlarni **TASK-000 (scaffold) yaratadi** — u `done`
bo'lguncha quyidagi nomlar maqsad, mavjud holat emas.

1. **Lint** — `npm run lint` zero errors (paket-chegara qoidalari shu yerda).
2. **Typecheck** — `npm run typecheck` (`tsc --noEmit`, `strict`) zero errors.
   `as any` / `@ts-ignore` only with a documented reason comment.
3. **Tests** — `npm test` (vitest): happy path + at least one error/edge case
   per unit; no regressions. `shared` validatsiya qoidalari va `engine`
   diff-mantiq — har tarmoq (branch) qamralgan. **Tizim buyruqlari mock** —
   test hech qachon haqiqiy `route`/`launchctl` chaqirmaydi.
   Hammasi: `npm run verify`.
4. **Acceptance criteria** — every `[ ]` item checked `[x]` (Real-Mac
   bandlaridan tashqari — pastga q.).
5. **Docs sync** — IPC protokol, config formati yoki fayl yo'llari o'zgargan
   bo'lsa `route-switch-docs/RouteSwitch.md` (yoki yangi ADR) ham shu sessiyada
   yangilangan.

---

## Security gate

Builders run these before `in-review`. QA re-runs during review.
No task moves to `done` with an unresolved finding. Manba:
`RouteSwitch.md` §Xavfsizlik talablari — MVP'da hammasi majburiy.

1. **Secret scanning** — hardcoded keys/tokens/passwords, imzolash materiali
   (`CSC_LINK`, `.p12`), `.env` qiymatlari manbada yo'q.
2. **Dependency audit** — `npm audit --audit-level=high`. Zero high/critical
   (istisnolar `memory/decisions.md` da). Helper'ga yangi bog'liqlik — alohida
   asoslanadi (root'da ishlaydi).
3. **Command execution** — `grep -rnE "\bexec(Sync)?\(|shell:\s*true|child_process" packages/`
   natijasi faqat ruxsat etilgan `execFile` wrapper'ini ko'rsatadi; har binar
   absolyut yo'l bilan.
4. **Input validation** — socket'dan kelgan har xabar (helper) va har
   `ipcMain.handle` kirishi (app main) zod'dan o'tadi; IP/CIDR `ipaddr.js`
   bilan parse → normalizatsiya; domen regex. Testlar rad etishni assert qiladi
   (`10.0.0.0/33`, `0.0.0.0/0`, `../etc`).
5. **Privilege boundary** — protokolda ixtiyoriy buyruq/eval metodi yo'q;
   default-route himoyasi (`0.0.0.0/0`, `default`, `127.0.0.0/8`,
   `224.0.0.0/4`) testlangan; engine faqat `applied` dagini o'chiradi;
   resolver faqat `# managed-by: routeswitch` belgili fayllarga tegadi; fayl
   nomi validatsiyadan o'tgan (traversal testi).
6. **Limits** — ≤500 qoida, domen boshiga ≤32 IP, `refreshSec` ≥ 60 (schema +
   test).
7. **Electron hardening** — `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`, CSP `default-src 'self'`, tashqi URL/navigatsiya yo'q.
8. **File permissions** — socket `0660 root:staff`; config/plist `0644`,
   binar `0755 root:wheel` (install skriptida).

---

## Logging / observability

Every task that introduces runtime behavior ships logging as part of
Definition of Done:

1. **Helper log** — `/Library/Logs/RouteSwitch/helper.log`; har yozuvda
   `level`, vaqt (`at`, ISO), `msg`, va tegishli bo'lsa `reason` (reconcile
   sababi), `ruleId`, `dst`, `gateway`. **Har tizim-buyrug'i chaqiruvi** (binar
   + argumentlar + chiqish kodi) logga yoziladi.
2. **`log` event** — foydalanuvchiga tegishli `info`/`warn`/`error` xabarlar
   `{ event: 'log', level, msg, at }` sifatida UI Jurnaliga ham boradi.
3. **Error reporting** — every `catch` logs at `error` or rethrows; hech bir
   xato jim yutilmaydi. Qoida darajasidagi xato `EngineState` da ko'rinadi.
4. **No `console.log`** helper va main'da — faqat logger. Log'ga parol yoki
   foydalanuvchi sirlari tushmaydi (admin parolni `sudo-prompt` oladi, biz
   ko'rmaymiz ham).

---

## Real-Mac gate

Routing, DNS, launchd, sleep/wake, reboot, kabel uzish — unit-test bilan
isbotlanmaydi. `RouteSwitch.md` §Test rejasi jadvali (13 holat) — real Mac'da,
qo'lda, **foydalanuvchi tomonidan**.

- Agent `sudo`, `route add|delete`, `launchctl`, `networksetup -set…`,
  install/uninstall skriptlarini **o'zi yuritmaydi** (root `CLAUDE.md`
  §Tizimga tegish qoidasi). Faqat-o'qish diagnostikasi (`route -n get`,
  `netstat -rn`, `scutil --dns`) erkin.
- Real-Mac AC'li task: Builder handoff'ida **aniq buyruqlar + kutilgan natija**
  ro'yxati; QA qolgan hamma gate'ni o'tkazadi va taskni
  `blocked (awaiting-real-mac-check)` qiladi; foydalanuvchi natijani aytgach —
  `[x]` va `done`.
- Tekshirilmagan narsa "tekshirildi" deb yozilmaydi.
