# Kaynaklar ve araç değerlendirmesi

Bu dosya iki şeyi kaydeder:

1. **Projeye gerçekten entegre edilen** araçlar (ve neden).
2. **İncelenip bilinçli olarak alınmayan** öneriler (ve neden) — böylece "baktım ama
   kapsamı bozacağı için eklemedim" kararları kayıt altında kalır.

Tüm lisans bilgileri 7 Kasım 2026'da GitHub API üzerinden doğrulandı.

---

## 1. Entegre edilenler

| Araç | Lisans | Nerede / nasıl kullanılıyor | Neden işe yaradı |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) `r169` | MIT | `src/render/**`, üretim build'ine gömülü | Tek render bağımlılığı; ağır motor olmadan FPS görünümü |
| [esbuild](https://github.com/evanw/esbuild) | MIT | `build.mjs` → `dist/SifirNokta.html` | Tüm oyunu ~0.1 s'de tek dosyaya indiriyor (offline oynanabilir artifact) |
| [jsdom](https://github.com/jsdom/jsdom) | MIT | `tests/ui.test.js`, `tests/app.e2e.test.js`, `tools/qa.mjs` | Gerçek `src/main.js`'i tarayıcısız çalıştırıp menü→maç→duraklatma→maç sonu akışını test etmek |
| [ESLint](https://github.com/eslint/eslint) + `@eslint/js` | MIT | `npm run lint` | 14 gerçek hata yakaladı (kullanılmayan importlar, kendine atama, tanımsız değişken, ölü kod) |
| [Node.js test runner](https://nodejs.org/api/test.html) | MIT | `npm test` (85 test) | Ek bağımlılık yok, `node:test` + `node:assert` yeterli |
| [lil-gui](https://github.com/georgealways/lil-gui) ★1.6k | MIT | `src/main.js` → **F2 denge paneli** | Dat.GUI'nin bakımlı, bağımlılıksız devamı. Denge değerlerini (hasar, can, nişan hatası, zorluk) oyun içinde canlı değiştirmek için — şartnamenin "ayarlanabilir veri" isteğine doğrudan hizmet ediyor. `npm run build` bunu da tek dosyaya gömüyor. |
| [axe-core](https://github.com/dequelabs/axe-core) ★7.8k | MPL-2.0 | `tools/a11y.mjs` → `npm run a11y` | WCAG 2.1 A/AA taraması (jsdom, gerçek markup). **6 ekranda 18 ihlal → 0 ihlal**: landmark/rol hataları (dialog, main, nav, log) ve h2 başlık kimlikleri düzeltildi. Lisans gereği axe yalnızca geliştirme bağımlılığıdır, üretim build'ine girmez (MPL uyumu). |
| [agency-agents](https://github.com/msitarzewski/agency-agents) | MIT | Bu iş akışının organizasyonu (QA/regresyon katmanı) | Ajansın "her uzman ayrı sorumluluk" fikri → `tools/qa.mjs` ile otomatik **QA ajanı** katmanı: senaryoları koşup `docs/QA-REPORT.md` üretir |
| [project-based-learning](https://github.com/practical-tutorials/project-based-learning) | MIT | `README.md` §8 (Unity'ye taşıma notları) | "Önce çalışan çekirdek, sonra motor" yaklaşımı ve motor eşleme tablosunun dayanağı |
| [public-apis](https://github.com/public-apis/public-apis) | MIT | **Bilinçli olarak kullanılmadı** (aşağıya bakın) | Oyun çevrimdışı ve hesapsız olmalı |

Ek olarak değerlendirilen FPS referansları (kod kopyalanmadı, yalnızca yaklaşım okundu):

- [mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty) (MIT) — Three.js FPS iskeleti.
- [mohsenheydari/three-fps](https://github.com/mohsenheydari/three-fps) (MIT) — pointer-lock + hareket örneği.
- [corosolto/client](https://github.com/corosolto/client) (AGPL-3.0) — **lisans nedeniyle kullanılmadı**;
  AGPL kodunu bu MIT projesine almak lisans uyumsuzluğu yaratırdı.

---

## 2. Bilinçli olarak alınmayanlar

| Öneri | Neden alınmadı |
|---|---|
| **public-apis** (dış API'ler) | Oyun şartnamesi **çevrimdışı, tek oyunculu, hesapsız** olmalı. Dış servis çağrısı hem şartnameye aykırı hem de "internet yokken çalışmaz" hale getirirdi. Hiçbir ağ isteği yok — `dist/SifirNokta.html` tamamen kendi kendine yeterli. |
| **Unity / Unity Hub** | Bu ortamda Unity Editor, lisans ve build aracı yok. Gerçek bir `.exe` üretilemez; üretilmiş gibi raporlamak yanlış olurdu (bkz. README platform notu). |
| **Vite / webpack** | `tools/serve.mjs` (60 satır, bağımlılıksız) ve `esbuild` yeterli. Ek dev sunucusu katmanı kapsam dışı. |
| **TypeScript / ağır framework (React vb.)** | MVC'i sade tutmak için. Tip güvenliği yerine 81 çalıştırılabilir test + ESLint kullanıldı. |
| **Fizik motoru (cannon/rapier/ammo)** | Harita eksen hizalı kutulardan oluşuyor; kendi AABB çarpışma + ray-cast kodumuz hem daha hızlı hem **deterministik** (bot davranışı test edilebilir kalıyor). |
| **NavMesh kütüphanesi (recast-navigation vb.)** | Harita düz zemin + kutular olduğu için A* ızgara çözümü daha basit ve doğrulanabilir. Unity'ye taşınırken `NavMeshAgent` ile değiştirilecek (README §8). |
| **Ses/3D model asset paketleri** | Lisans doğrulama yükü + "özgün asset" şartı. Tüm modeller primitif mesh, tüm sesler WebAudio ile sentetik. |
| **Analytics / telemetri / backend** | Şartname dışı; çevrimdışılığı bozar. |
| **Büyük tarayıcı otomasyonu (Playwright indirmesi)** | Sandbox yalnızca npm/GitHub/PyPI'ye çıkış veriyor, Chrome indirilemedi. Yerine jsdom + WebGL'siz renderer shim kullanıldı (bkz. README test raporu). |

---

## 3. Bu değerlendirmenin ürüne katkısı

- **ESLint** → `src/core/game.js`, `bot.js`, `main.js` içinde ölü kod/kullanılmayan importlar temizlendi;
  `bot.js`'te kullanılmayan `LANES` sabiti ve `advanceGoal`'un kullanılmayan `match` parametresi kaldırıldı.
- **jsdom + gerçek `main.js`** → üç kritik hata yakalandı:
  1. `applyPose` içinde `HIP`/`ADS` kapsam hatası (**oyun açılışta çöküyordu**),
  2. `build.mjs`'te `String.replace` ile `$` genişlemesi (**üretim dosyası bozuk çıkıyordu**),
  3. HUD'un ilk karede bir önceki maçtan kalma değerleri göstermesi.
- **Otomatik QA ajanı (`tools/qa.mjs`)** → kolay botların raundların %72'sini süre limitine bıraktığını
  ölçtü; zorluk profilleri yeniden dengelendi (kolay: görüş 30→38 m, FOV 100→112°, investigate 3.5→2.4 s,
  `pushAfter` merkezi parametresi). Sonuç: kolayda tıkanma %72 → %39, normal %31 → %25, zor %35 → %27.
- **FPS referansları** → pointer-lock + `unadjustedMovement` geri düşüşü ve `movementX/Y` tabanlı bakış
  yaklaşımı doğrulandı (kod kopyalanmadı).
- **lil-gui** → oyun içi denge paneli (F2). Değerler doğrudan `config.js` nesnelerine yazıldığı için
  "ayarla → hisset" döngüsü saniyeler sürüyor; "Değerleri konsola yaz" ile config'e geri taşınabiliyor.
- **axe-core** → erişilebilirlik kapısı. Elle yazılmış işaretlemedeki gerçek hataları buldu:
  ekranların landmark'ı yoktu, dialog rolleri ve `aria-labelledby` hedefleri eksikti, killfeed
  `role="log"` değildi. Hepsi düzeltildi ve `npm run verify` artık bunu zorunlu tutuyor.
