// The Help in Uzbek. The names of buttons and sections come from the
// dictionary (`MESSAGES.uz`), so the guide names what the screen shows.
// Examples are generic only: 10.0.0.0/8, corp.local, example.com.

import { MESSAGES } from '../../../i18n';
import { code, list, note, p, steps, sub, terminal, toSection, toTopic, ui, type HelpDoc } from './types';

const m = MESSAGES.uz;
const section = m.rules.sections;

export const helpUz: HelpDoc = {
  title: 'Yordam',
  subtitle: "RouteSwitch qanday ishlaydi va biror narsa kutilganidek ishlamasa nima qilish kerak.",
  contents: 'Mundarija',
  topics: {
    start: {
      title: 'Boshlash',
      blocks: [
        p(
          "RouteSwitch tanlangan manzillar (IP, subnet yoki domen) trafigini aniq bir interfeys — Ethernet yoki Wi‑Fi — orqali yuboradi. ",
          "Qolgan hamma trafik avvalgidek default kanaldan ketadi. Odatiy holat: ichki tizimlar Ethernet orqali, internet Wi‑Fi orqali.",
        ),
        steps(
          [
            "Menu bar'dagi RouteSwitch ikonkasini bosing. ",
            ui(m.notice.notInstalledTitle),
            ' deyilgan bo\'lsa, ',
            ui(m.install.install),
            " tugmasini bosing va administrator parolini bir marta kiriting.",
          ],
          [ui(m.menuBar.manageRules), ' → ', toSection('rules', section.rules), ' → ', ui(m.rules.addRule), '.'],
          [
            'Turi ',
            ui(m.addRule.kinds.subnet),
            ', manzil ',
            code('10.0.0.0/8'),
            ', interfeys ',
            ui('Ethernet'),
            '. ',
            ui(m.addRule.test),
            " hozir bu manzil qaysi interfeysdan ketishini ko'rsatadi; so'ng ",
            ui(m.addRule.save),
            '.',
          ],
        ),
        p(
          "Helper — routing'ga tegadigan yagona jarayon — root huquqida, launchd ostida ishlaydi. Ilova yopilsa ham route'lar saqlanadi.",
        ),
        p("Tekshirish uchun Terminal'da (faqat o'qiydi, hech narsani o'zgartirmaydi):"),
        terminal("Route'ni tekshirish", 'route -n get 10.1.2.3'),
        p(
          "Javobdagi ",
          code('interface'),
          " qatori Ethernet qurilmasini ko'rsatishi kerak. Kabel, Wi‑Fi tarmog'i o'zgarganda yoki Mac uyqudan uyg'onganda qoidalar avtomatik qayta qo'llanadi.",
        ),
      ],
    },

    'rule-types': {
      title: 'Qoida turlari',
      blocks: [
        list(
          [ui(m.addRule.kinds.ip), ' — bitta host, masalan ', code('10.20.30.40'), '.'],
          [
            ui(m.addRule.kinds.subnet),
            ' — CIDR ko\'rinishidagi tarmoq, masalan ',
            code('10.0.0.0/8'),
            ". Butun ichki tarmoq uchun eng ishonchli variant.",
          ],
          [
            'IP wildcard — ',
            code('10.*.*.*'),
            ' yoki ',
            code('10.20.*.*'),
            '. «*» faqat oxirgi oktetlarda bo\'ladi; qoida subnet sifatida saqlanadi: ',
            code('10.*.*.*'),
            ' → ',
            code('10.0.0.0/8'),
            ', ',
            code('10.20.*.*'),
            ' → ',
            code('10.20.0.0/16'),
            '.',
          ],
          [
            ui(m.addRule.kinds.domain),
            ' — masalan ',
            code('corp.local'),
            ". Domenning A-yozuvlari (IPv4) resolve qilinadi va har IP uchun route qo'shiladi; IP'lar vaqti-vaqti bilan yangilanadi. ",
            'Faqat aniq nom: ',
            code('app.corp.local'),
            ' uchun alohida qoida kerak, ',
            code('*.corp.local'),
            " ko'rinishi qo'llab-quvvatlanmaydi.",
          ],
        ),
        p(
          ui(m.addRule.useDns),
          ' (domen qoidasida) — ichki nomlarni faqat ofis DNS serveri bilsa, uning manzilini kiriting, masalan ',
          code('10.0.0.53'),
          '. Shunda ',
          code('/etc/resolver/corp.local'),
          " fayli yaratiladi: macOS corp.local nomlarini shu serverdan so'raydi, serverning o'ziga esa qoida interfeysi orqali route qo'shiladi.",
        ),
        note(
          "Taqiqlangan manzillar hech qachon yo'naltirilmaydi: default route (",
          code('0.0.0.0/0'),
          '), juda keng subnetlar, loopback, link-local va multicast.',
        ),
      ],
    },

    precedence: {
      title: 'Ustunlik: qaysi qoida yutadi',
      blocks: [
        p('Bitta manzilga bir nechta qoida tegsa:'),
        steps(
          [
            "Aniq ko'rsatilgan manzil resolve qilingan manzildan ustun: IP qoidasi (yoki ",
            code('/32'),
            ", yoki qoidaning DNS serveri) domen javobidan kelgan o'sha IP'ni oladi. Domen qoidasida «",
            m.ruleReason['overridden-by-rule'],
            '» izohi chiqadi.',
          ],
          [
            "Eng aniq (eng uzun prefiksli) route yutadi — macOS shunday tanlaydi. Masalan ",
            code('10.0.0.0/8'),
            ' Ethernet orqali, ',
            code('10.20.0.0/16'),
            ' esa Wi‑Fi orqali bo\'lishi mumkin; domenning har IP\'si host route (',
            code('/32'),
            "), shuning uchun u kengroq subnetdan ustun.",
          ],
          ["Teng bo'lsa — ro'yxatda yuqoridagi qoida."],
        ),
        p(
          "Bitta manzil ikki interfeysga bog'lanmaydi — forma bunday qoidani saqlamaydi. Qaysi qoida ishlayotganini ",
          toSection('diagnostics', section.diagnostics),
          " aniq ko'rsatadi.",
        ),
      ],
    },

    'default-route': {
      title: '«Default» nima va Wi‑Fi\'ni birinchi qilish',
      blocks: [
        p(
          "Hech bir qoidaga tushmagan trafik default kanaldan ketadi. macOS uni tarmoq xizmatlari tartibidan oladi: ro'yxatdagi birinchi ulangan xizmat. ",
          "Menu bar'dagi interfeys kartasida DEFAULT belgisi shuni ko'rsatadi.",
        ),
        p(
          "Ethernet ro'yxatda Wi‑Fi'dan yuqori bo'lsa, internet ham kabel orqali ketadi. RouteSwitch default route'ga tegmaydi; tartibni o'zgartirish administrator huquqini talab qiladi, shuning uchun ",
          toSection('settings', section.settings),
          ' → ',
          ui(m.settings.wifi.title),
          " kartasi sizning xizmatlaringiz uchun tayyor buyruqni ko'rsatadi — uni nusxalab, Terminal'da o'zingiz bajarasiz. U taxminan shunday ko'rinadi:",
        ),
        terminal("Wi‑Fi'ni birinchi qiladigan buyruq (namuna)", 'sudo networksetup -ordernetworkservices "Wi-Fi" "USB 10/100/1000 LAN"'),
        p("Joriy tartib va default route'ni ko'rish (faqat o'qiydi):"),
        terminal("Tartib va default route'ni ko'rish", 'networksetup -listnetworkserviceorder', 'route -n get default'),
      ],
    },

    backup: {
      title: 'Zaxira, tiklash va Export',
      blocks: [
        p(
          "Qoidalar helper'da saqlanadi. Ilova esa helper'dan ko'rgan oxirgi qoidalar nusxasini o'z papkangizda saqlab boradi (faqat siz o'qiy olasiz).",
        ),
        list(
          [
            "Helper qayta o'rnatilganda qoidalar bo'sh, zaxira esa bor bo'lsa — oldingi qoidalarni tiklash taklif qilinadi. Tiklash faqat ko'rib chiqib tasdiqlaganingizdan keyin bo'ladi.",
          ],
          [
            toSection('settings', section.settings),
            ' → ',
            ui(m.backup.settings.title),
            ': ',
            ui(m.backup.settings.restore),
            " yoki zaxirani o'chirish.",
          ],
          [
            toSection('rules', section.rules),
            ' → ',
            ui(m.rules.export),
            ' qoidalarni JSON faylga saqlaydi, ',
            ui(m.rules.import),
            " esa fayldan yuklaydi (joriy qoidalarni to'liq almashtiradi, oldin ko'rib chiqasiz). Boshqa Mac'ga o'tkazish uchun shu yo'l.",
          ],
        ),
        note(
          "Helper'ni o'chirishdan oldin ",
          ui(m.rules.export),
          " qiling: o'chirish helper'dagi qoidalarni ham o'chiradi. Ilova zaxirasi qoladi, lekin fayl — ishonchli nusxa.",
        ),
      ],
    },

    diagnostics: {
      title: 'Diagnostika',
      blocks: [
        p(
          toSection('diagnostics', section.diagnostics),
          " bo'limiga xost, IP yoki URL kiriting (masalan ",
          code('corp.local'),
          ', ',
          code('10.20.30.40'),
          ' yoki ',
          code('https://example.com/page'),
          ' — URL\'dan faqat xost olinadi) va ',
          ui(m.diagnostics.run),
          " tugmasini bosing. Natijada ko'rasiz:",
        ),
        list(
          ['qaysi qoida mos keladi va nega (ustunlik);'],
          ["har manzil uchun haqiqiy route: interfeys, gateway va kutilgani bilan mosmi;"],
          ['qaysi DNS server va resolver fayli ishlatiladi, server javob beradimi.'],
        ),
        p(
          "Diagnostika hech narsani o'zgartirmaydi. Hech bir qoidaga tushmagan nomni ilova tizim resolveri bilan oddiy foydalanuvchi huquqida yechadi.",
        ),
      ],
    },

    problems: {
      title: 'Tez-tez uchraydigan muammolar',
      blocks: [
        sub('DNS server boshqa interfeysdan ketmoqda'),
        p(
          "Masalan Ethernet bergan DNS server Wi‑Fi tarmog'i ichida yotadi — so'rovlar Wi‑Fi'dan ketadi va javob kelmaydi. RouteSwitch menu bar'da va ",
          toSection('rules', section.rules),
          " bo'limida ogohlantirish ko'rsatadi; uning ",
          ui(m.dnsWarnings.addRule('10.0.0.53', 'Ethernet')),
          " tugmasi formani to'ldirib ochadi — saqlashni siz tasdiqlaysiz.",
        ),
        sub("Ichki nom brauzerda ochilmaydi, Terminal'da esa ishlaydi"),
        p(
          "Brauzerdagi Secure DNS (DNS-over-HTTPS) tizim resolverini, demak ",
          code('/etc/resolver/corp.local'),
          " ni ham chetlab o'tadi. Brauzer sozlamalarida Secure DNS'ni o'chiring yoki ichki domen uchun istisno qo'shing. IP va subnet qoidalariga bu ta'sir qilmaydi.",
        ),
        sub(`Qoidalar «${m.components.ruleStatus.pending}» holatida`),
        p(
          "Qoida interfeysi ulanmagan (masalan Ethernet kabeli uzilgan) yoki unda gateway yo'q. Shu payt bu manzillar default kanaldan ketadi; interfeys ulanishi bilan qoidalar avtomatik qo'llanadi.",
        ),
        sub("«Tekshiruvlar juda ko'p»"),
        p(
          "Helper daqiqasiga 10 tagacha diagnostika so'rovini bajaradi (qoidaga tushmagan nomning har manzili — alohida so'rov). Bir daqiqa kutib, qayta urinib ko'ring.",
        ),
        p(
          "Boshqa xatolar sababini ",
          toSection('log', section.log),
          " ko'rsatadi; kerak bo'lsa ",
          toTopic('diagnostics', 'Diagnostika'),
          ' bilan tekshiring.',
        ),
      ],
    },

    uninstall: {
      title: "O'chirish",
      blocks: [
        steps(
          [
            'Kerak bo\'lsa avval ',
            ui(m.rules.export),
            ' (',
            toTopic('backup', 'Zaxira, tiklash va Export'),
            ').',
          ],
          [
            toSection('settings', section.settings),
            ' → ',
            ui(m.settings.helper.uninstall),
            " (administrator paroli): helper qo'shgan barcha route'lar va resolver fayllari, daemon, uning config'i (qoidalar) va log olib tashlanadi.",
          ],
          ["RouteSwitch'dan chiqing va uni Applications papkasidan Savatga o'tkazing."],
        ),
        p("Ilovadagi qoidalar zaxirasi o'z-o'zidan o'chmaydi — uni o'chirish uchun Sozlamalardagi zaxira kartasidan foydalaning."),
      ],
    },
  },
};
