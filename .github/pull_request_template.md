<!--
🔴 NISHON BRANCH: `staging` (base). `main` — reliz-branchi.
Branch `origin/staging` dan olinadi:
  git fetch origin && git checkout -b task/TASK-123-ism origin/staging
-->

## Nima qilindi

<!-- Qaysi TASK, nima o'zgardi. Bir-ikki jumla. -->

TASK-

## Gate'lar

<!-- CLAUDE.md §Verification gates. Yiqilgan gate bilan PR ochilmaydi. -->

- [ ] `npm run verify` yashil (lint · typecheck · test)
- [ ] `npm audit --audit-level=high` — high/critical yo'q
- [ ] Task blokidagi barcha AC `[x]` (Real-Mac bandlari — pastda alohida)
- [ ] IPC protokol / config formati / fayl yo'llari o'zgargan bo'lsa hujjat ham yangilangan

## Xavfsizlik

- [ ] Shell yo'q — faqat `execFile` + absolyut yo'l
- [ ] Yangi kirish nuqtasi (socket xabari / `ipcMain.handle`) zod'dan o'tadi
- [ ] Sir, sertifikat, real ichki IP/domen tushmagan (repo **public**)

## Real Mac'da tekshirildi

<!-- Nima, qaysi buyruq bilan, natija. Tekshirilmagan bo'lsa — aniq yozing. -->

- [ ] `route -n get <ip>` kutilgan interfeysni ko'rsatdi
- [ ] Tegishli emas (routing/DNS/launchd'ga tegmaydi)

## Tekshiruv ro'yxati

- [ ] **Base branch = `staging`**
- [ ] Commit xabarida AI-mualliflik trailer'i YO'Q

## QA uchun eslatma

<!-- Nozik joylar, ongli chetlanishlar, qaror talab qiladigan bandlar. -->
