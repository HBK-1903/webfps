# SIFIR NOKTA — Taktik Eğitim Tesisi

Çevrimdışı, tek oyunculu **5v5 taktik FPS** prototipi: oyuncu + 4 AI takım arkadaşı, 5 AI rakip,
raundlu takım eleme, en iyi 5 raunt (ilk 3'ü alan kazanır), Kolay/Normal/Zor bot zorluğu.
Low-poly, özgün harita/silah/arayüz — hiçbir ticari oyunun haritası, kodu, modeli veya logosu kullanılmadı.

> **Platform notu — lütfen önce okuyun.** Şartname Unity + Windows `.exe` istiyordu. Bu geliştirme
> ortamında **Unity Editor, Unity Hub veya bir build aracı yok** (lisans, IL2CPP ve derleyici yok), bu
> yüzden gerçek bir Unity `.exe`'si **üretilmedi ve üretildi gibi raporlanmadı**. Bunun yerine aynı MVP
> şartnamesi, aynı mimari ayrımıyla (Core / Player / Weapons / AI / Match / UI / Data) **tarayıcı
> motorunda gerçek ve test edilebilir** biçimde kuruldu ve PC'de "program gibi" çalışacak şekilde
> paketlendi (çift tıkla açılan tek dosya + adres çubuğu olmayan tam ekran pencere).
> Ayrıntı: [Platform ve kapsam](#platform-ve-kapsam) · [Unity'ye taşıma](#unityye-taşıma-notları).

---

## 1. Hızlı başlangıç

### Geliştirme (canlı önizleme)
```bash
npm install
npm run dev          # http://localhost:5173
```

### PC'de program olarak çalıştırma (önerilen, internet gerekmez)
```bash
npm run build        # -> dist/SifirNokta.html  (tek dosya, her şey gömülü)
```

| İşletim sistemi | Komut | Sonuç |
|---|---|---|
| Windows | `tools\launch-windows.bat` çift tıkla | Chrome/Edge ile **adres çubuğu olmayan** oyun penceresi (1600×900) |
| Linux / macOS | `./tools/launch.sh` | Aynı davranış (Chrome/Chromium/Edge), yoksa varsayılan tarayıcı |
| Herhangi | `dist/SifirNokta.html` çift tıkla | Tarayıcıda sekmeli tam ekran oynanır |

`launcher` betikleri Chrome/Edge'i `--app=` modunda açar: sekme yok, adres çubuğu yok, ayrı profil
(`%TEMP%\sifirnokta-profile`).

### Kurulabilir uygulama (PWA) ve gerçek `.exe`

Üç dağıtım yolu var; hepsi aynı oyundan üretilir, ayrı kod yok.

**a) PWA — "Yükle" ile uygulama olur (tek kod tabanı, ~1.3 MB)**
```bash
npm run build:site     # -> dist/site/  (index.html, manifest, sw.js, ikonlar, _headers)
npm run preview:site   # http://localhost:8080 — Chrome/Edge'de "Yükle" düğmesi çıkar
```
Kurulduktan sonra oyun **kendi penceresinde** açılır (tarayıcı çubuğu yok), Başlat menüsünde görünür ve
service worker sayesinde **internet olmadan** çalışır. Oyun içi menüde de "UYGULAMA OLARAK YÜKLE"
düğmesi belirir — ama yalnızca tarayıcı gerçekten kurabiliyorsa (HTTPS veya localhost gerekir;
`file://` üzerinde düğme görünmez, çünkü orada kurulum diye bir şey yoktur).

Yayınlamak için `dist/site` klasörünü olduğu gibi yükle:

| Servis | Ayar |
|---|---|
| Cloudflare Pages | Build: `npm install && npm run build:site` · Çıktı: `dist/site` |
| Netlify | Build: `npm run build:site` · Publish: `dist/site` |
| GitHub Pages | `dist/site` içeriğini `gh-pages` dalına koy |

`dist/site/_headers` dosyası Cloudflare/Netlify için hazır: sıkı CSP, `nosniff`, `no-referrer`,
`frame-ancestors 'none'`, ve "giriş dosyalarını asla önbelleğe alma" kuralı (yoksa yeni sürüm
oyunculara günlerce ulaşmaz).

**b) Windows `.exe` (NSIS kurulum + tek dosya portable)**
```bash
npm run app        # geliştirme: Electron penceresinde aç
npm run app:dist   # -> dist-app/SIFIR-NOKTA-0.9.0-x64.exe (+ portable)
```
Pencere: 1600×900 (ekrana göre küçültülür), menü çubuğu yok, `backgroundThrottling` kapalı (oyun
arkada kalınca yavaşlamasın), F11 tam ekran, F12 DevTools. Güvenlik: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true` — renderer'a verilen tek yetenek "çıkış" köprüsü.

**Önemli:** Windows `.exe` dosyası Linux'ta üretilemez (Wine ya da Windows gerekir). Bu yüzden
`.github/workflows/desktop.yml` üç platformda native derleme yapar:
Actions → **desktop** → Run workflow → `windows` seç → çalışma bitince artifact olarak `.exe` iner.
`v*` etiketi atarsan aynı iş akışı dosyaları GitHub Release'e ekler.

Kod imzalama sertifikası olmadığı için Windows ilk çalıştırmada SmartScreen uyarısı verir:
**Ek bilgi → Yine de çalıştır**.

**c) Mevcut `--app` başlatıcıları** — kurulum istemiyorsanız yukarıdaki tablo hâlâ geçerli.

**İkonlar** oyunun kendi paletinden üretilir, hazır dosya yoktur: `npm run icons` → `icons/*.png` + `build/icon.ico`
(4x supersampling ile PNG ve ICO yazan küçük bir betik; harici görsel kütüphanesi kullanmaz).

### Testler ve kalite kapısı
```bash
npm test             # 121 test, tamamı headless (Node + jsdom)
npm run lint         # ESLint (gerçek hata odaklı kural seti)
npm run verify       # lint + test + build — tek komutta tam doğrulama
npm run qa           # scripted playtest → docs/QA-REPORT.md
npm run sim -- normal 7 3   # zorluk, seed, maç sayısı ile headless maç simülasyonu
```

---

## 2. Kontroller

| Girdi | İşlev |
|---|---|
| `W A S D` | Hareket |
| Fare | Bakış (pointer lock) |
| Sol tık | Ateş (tüfek tam otomatik, tabanca tek tek) |
| Sağ tık | Nişan / zoom (ADS) |
| `R` | Yeniden doldur |
| `1` / `2` / Fare tekerleği | Tabanca / Tüfek |
| `Shift` | Koşma |
| `Ctrl` | Çömelme |
| `Esc` | Duraklat / devam |
| `F2` | Denge ayar paneli — can/zırh/kafa çarpanı, bot nişan hatası, silah hasarı/atış hızı canlı ayarlanır |
| `F3` | Hata ayıklama katmanı (bot durumları, şeritler, konumlar, siper/çömelik/destek etiketleri, hedefler) |
| Pencere odağı kaybı | Otomatik duraklatma (input ve botlar durur) |

Ayarlar: fare hassasiyeti, ses düzeyi, görüş açısı (FOV), grafik kalite, silah sarsıntısı açık/kapalı.
Hepsi `localStorage`'da saklanır ve yeniden açılışta korunur.

---

### Nişangah ve nişan hattı (bu sürümde düzeltildi)

| Sorun | Etki | Düzeltme |
|---|---|---|
| Nişangah HUD'un alt satırının içindeydi | Merkezden **16 px** kayık (1600 px'te) ve mermi hacmiyle değişiyordu | Ayrı `reticle-layer`, tam ekran merkezinde |
| ADS nişangahı kamera ekseninde değildi | Arpacık **4–6 cm** altta; 30 m'de 1 m'den fazla sapma | ADS konumu nişangah yüksekliğinden hesaplanıyor, ölçülü test var |
| Geri tepme her atışta sıfırlanıyordu | 7 atışlık seri, tek atış kadar tırmanıyordu | Tepme birikiyor, sönümleniyor, atışa *ve* kameraya yansıyor |
| Botlar göz noktasına nişan alıyordu | Her isabet kafa (×2.5) | Gövde nişanı + zorluğa bağlı yukarı kayma |

## 3. Tamamlanan özellikler (MVP)

**Maç / raund**
- 5v5: oyuncu + 4 takım botu (ALFA) vs 5 rakip bot (BRAVO).
- Raund başında 3 saniyelik geri sayım: ateş, hasar ve hareket kilitli, bakış serbest.
- Raund içinde yeniden doğma yok; bir takım tamamen elenince raund biter.
- İlk 3 raundu alan maçı kazanır (max 5 raund). 2-2 beraberlik de doğru raporlanır.
- Raund sonu ekranı, skor, pip göstergeleri, maç sonu istatistikleri, yeniden maç / ana menü.
- Tek yetkili durum makinesi (`MatchManager`) — çift raund/maç tetiklenmesi engellenir (idempotent).
- **Kamp yapmama:** temas olmayan raundlarda takım tek arama bölgesini birlikte süpürür, 26 s'den sonra
  iki takım da haritanın merkezine yürür. Bu, raundların süre limitine takılmasını pratikte bitirdi
  (ölçülen tıkanma oranı **%0–3**).
- **Tıkanma koruması (son çare):** 80 saniyede çözülmeyen raund hayatta kalan sayısı → toplam can/zırh ile
  karara bağlanır.

**Oyuncu ve silahlar**
- FPS hareketi: ivme, sürtünme, duvar kaydırma, sub-step çarpışma (tünelleme yok), çömelme yüksekliği.
- İki özgün silah, tümü merkezi ayarda (`src/core/config.js`):

| | K-7 TABANCA | AR-14 TÜFEK |
|---|---|---|
| Hasar | 24 | 26 |
| Atış hızı | 330 rpm, tek tek | 600 rpm, otomatik |
| Şarjör / yedek | 12 / 48 | 30 / 90 |
| Şarjör değiştirme | 1.45 s | 2.10 s |
| Geri tepme (pitch/yaw, toparlanma) | 1.05° / 0.45°, 9°/s | 0.62° / 0.30°, 6.2°/s |
| Yayılma | 0.4° → 3.0° | 0.55° → 4.2° |
| Menzil / düşüş | 70 m, %60 taban | 110 m, %60 taban |

- Hasar düşüşü, kafa çarpanı ×2.5, zırh hasarın **%50'sini** emer (asla bağışıklık değil), dost ateşi kapalı.
- **Vuruş hacimleri üst üste binmez.** Gövde silindiri kafa küresinin *altında* biter. Eskiden
  gövde 1.36'ya, kafa 1.33'e kadar uzanıyordu; üst göğüse nişan alan her atış "kafa" sayılıyordu.
- **Botlar gövdeye nişan alır, kafaya değil.** Eskiden nişan noktası göz noktasıydı (kafa küresinin
  içinde): 4–34 m arası her atış kafa vuruşuydu ve normal bir bot oyuncuyu ~0.3 s'de öldürüyordu.
  Artık taban gövde, zorluk yükseldikçe nişan yukarı kayar (kolay gövde, zor üst göğüs/çene hattı).
- Reload / silah değiştirme / ölüm / raund sonu kuralları tutarlı: reload iptali, boş şarjörde otomatik reload,
  ölümde ve raund sonunda kontroller susar.
- Vuruş geri bildirimi: hitmarker (öldürmede kırmızı), kafa isabeti sesi farklı, kan/gore yok.

**Bot AI** (`src/core/bot.js`)
- Görüş: FOV konisi + mesafe + **gerçek LOS raycast** — duvar arkası görülmez, zorluk LOS'u atlatmaz.
- Son görülen konumu araştırma; ses ipuçları **yaklaşık** konum verir (tam koordinat sızdırmaz).
- A* ızgara navigasyonu, 3 şerit (orta/kuzey/güney), takım arkadaşları arasında şerit dağıtımı,
  paylaşılan arama bölgesi (yığılma yerine yayılma), takım süpürmesi, sıkışma tespiti + yeniden yol bulma.
- Gövde çakışması çözülür (tek yönlü itme): botlar birbirinin içine girmez, kapılardan sırayla geçer.
- **Siper:** `src/core/cover.js` haritadaki 56 kutudan 156 aday siper noktası üretir; her nokta gerçek
  bir raycast ile doğrulanır (çömelmiş gövde o yönden gerçekten görünmüyor mu?). Botlar yaralandığında
  veya şarjörü bittiğinde en yakın uygun sipere gider, çömelir, kısa aralıklarla başını kaldırıp ateş eder
  ve süre bitince (en fazla ~3 s) tekrar saldırıya döner. Takım arkadaşları aynı noktayı "kapar", kimse
  aynı sandığın arkasına yığılmaz.
- **Destek:** vurulan bir bot takım arkadaşlarına haber verir (yalnızca *kendi* konumu — asla düşmanın
  konumu). 14 m içindeki, o anda çatışmada olmayan arkadaşlar yardıma gider; zorluk arttıkça tepki oranı artar.
- Durumlar: spawn → advance → engage → investigate → reload → retreat → hold.
- Detour hedefleri (siper, süpürme, kovalama) süreli kilit ile korunur; bot iki nokta arasında gidip gelmez.
- Silah yönetimi: boş şarjörde asla ateş etmez, reload eder, gerekirse tabancaya geçer.
- Zorluk yalnızca tepki süresi, nişan hatası, karar hızı ve koordinasyonu değiştirir (hasar sabit):

| | Kolay | Normal | Zor |
|---|---|---|---|
| Tepki | 0.62 s | 0.36 s | 0.20 s |
| Nişan hatası | 3.4° | 1.9° | 0.95° |
| Görüş açısı / mesafe | 100° / 30 m | 118° / 44 m | 135° / 60 m |
| Koordinasyon | %15 | %50 | %80 |

**Harita** (`src/core/map.js`)
- Simetrik, low-poly eğitim tesisi: iki ayna simetrik spawn odası, merkez blok + 9 m işaret kulesi,
  kuzey/güney yan koridorları + orta hat, siperler/pilastırlar. 56 kutu, tek liste (görsel + çarpışma + LOS).
- Spawn noktaları karşılıklı görüş hattına kapalı (test edilir), spawn'a bakan siperler dengeli.
- Tüm harita primitiflerden üretilir — üçüncü taraf asset yok, lisans sorunu yok.

**Arayüz / ses**
- Kariyer: maçlar arası kalıcı istatistikler (§10e) — galibiyet oranı, K/D, isabet trendi, zorluk bazında
  ayrım, son 10 maç geçmişi, kişisel rekorlar. Bozuk kayıt dosyası oyunu asla çökertmez.
- Vuruş geri bildirimi (§10f): duvarda kalan kurşun izleri, yüzeye göre yönelen kıvılcımlar, düşen ceset.
- HUD: can, zırh, silah, şarjör/yedek, kendi takım listesi, canlı sayıları, skor, raund durumu,
  geri sayım, nişangâh (yayılmaya göre açılan), hitmarker, reload halkası, killfeed, hasar yönü,
  **taktik harita** (şerit bantları, takım arkadaşları, süresi dolan düşman temasları, konum etiketi)
  ve **pusula** (kayan şerit + iğne, ayrıca ekran okuyucu için metin).
- Menü → zorluk → ayarlar → kontroller → duraklatma → maç sonu akışının tamamı.
- Ses tamamen prosedürel (WebAudio): hiç ses dosyası yok, her ses kodla sentezleniyor. Katmanlı silah
  sesleri (crack + gövde + mekanizma + oda kuyruğu), mesafeye göre tiz kaybı, yürüyüş/koşma/eğilme için
  ayrı adım sesleri, üç aşamalı şarjör değişimi, düşman ateşinde stereo yön, ıskalayan kurşunun ıslığı.
  Ayrıntı ve ölçümler: §10c.

---

## 4. Mimari

```
src/
  core/                 # Oyun mantığı — DOM/WebGL bilmez, saf ve test edilebilir
  core/cover.js         # Haritadan türetilen siper noktaları (raycast doğrulamalı)
    config.js           # TÜM denge verisi (silah, zorluk, maç, oyuncu, varsayılan ayarlar)
    damage.js           # saf hasar/zırh formülü (oyuncu ve botlar aynı fonksiyonu kullanır)
    map.js              # simetrik harita, spawn ve rota noktaları
    collision.js        # AABB çarpışma, kaydırma, ray-cast, LOS
    navgrid.js          # ızgara + A* (+ yol yumuşatma)
    weapon.js           # ateş cadence, yayılma, geri tepme, reload, silah değiştirme
    actor.js            # oyuncu/bot ortak modeli + hitbox'lar
    combat.js           # atış çözümü (ray vs kap/baş), hasar uygulama
    match.js            # maç/raund durum makinesi (tek yetkili)
    player.js           # FPS hareketi ve kamera
    bot.js              # algı, davranış, takım koordinasyonu, işitme
    game.js             # headless orkestrasyon + FX/ses olayları (renderer bunu okur)
  render/               # Three.js sunumu — oyun durumunu değiştirmez
    scene.js  actorRigs.js  viewmodel.js  fx.js
  ui/                   # HUD, ses, ayarlar (localStorage)
  main.js               # uygulama kabuğu: menü akışı, input, pointer lock, render döngüsü
tests/                  # 121 test (core, AI, nişan, HUD, PWA, e2e app boot)
tools/serve.mjs         # dev sunucusu
tools/sim.mjs           # headless maç simülatörü
build.mjs               # tek dosya offline build
```

Tasarım kararı: **tüm oynanış `src/core`'da**, renderer sadece okur. Bu sayede maç akışı, hasar,
bot davranışı ve zorluk farkı tarayıcı olmadan da ölçülebiliyor (`npm test`, `npm run sim`).

---

## 5. Test raporu

`npm test` → **121/121 geçti** (Node 22 + jsdom, headless):

| Dosya | Kapsam |
|---|---|
| `tests/damage.test.js` (9) | Zırh absorbsiyonu (%50, bağışıklık değil), zırh tükenmesi, kafa çarpanı, ölüm sayımı, menzil düşüşü, dost ateşi kapalı, silah verisi özgünlüğü |
| `tests/weapons.test.js` (12) | Ateş hızı, tek/otomatik tetik, boş şarjör, reload transferi/iptali, ateş kilidi, geri tepme birikmesi/toparlanması, yayılma |
| `tests/match.test.js` (11) | 5v5 kurulum, geri sayım, eleme ile raund sonu, çift tetiklenmeme, raund reseti (can/zırh/ammo/pozisyon), ilk-3 zafer, beraberlik, tıkanma kararı, maç sonu dondurma |
| `tests/nav.test.js` (11) | Yürünebilirlik, spawn simetrisi ve güvenliği, A* erişilebilirliği, tünelleme yok, LOS, ray-cast |
| `tests/ai.test.js` (22) | Duvar arkasını görmeme, FOV konisi, zorluk farkı (ölçülmüş tepki/isabet), son bilinen konum, işitme gürültüsü, boş şarjörle ateş etmeme, harita dışına çıkmama, yığılmama, lane yürüyüşü (spawn'da kilitlenmeme), sessiz raundun çözülmesi (tıkanma bütçesi), tohumlu maç tekrarlanabilirliği (determinizm), takım arkadaşıyla ayrışma, siper noktalarının simetrisi + gerçekten saklaması, yaralı botun sipere gidip çömelmesi, siperin tek taraflı olması, yardım çağrısı ve **düşman konumu sızdırmaması** |
| `tests/packaging.test.js` (7) | Electron config'i (appId, hedefler, dosya listesi) parse edilip doğrulanır; renderer güvenliği (`contextIsolation`/`sandbox`/`nodeIntegration`), in-game çıkış köprüsü, PWA manifest + maskable ikon, service worker sürümleme/temizlik ve `file://`'de sessizce devre dışı kalma |
| `tests/aim.test.js` (16) | Nişangahın tam ekran merkezinde olması, ADS'in gerçekten kamera eksenine oturması, kafa/gövde hacimlerinin kesişmemesi, botların gövdeye nişan alıp zorlukla yükselmesi, geri tepmenin seri boyunca birikmesi, çömelirken nişan noktasının sıçramaması, ADS isabet bonusunun arpacıkla aynı eğride gelmesi, vuruş hacimlerinin ilan edilen boya tam oturması, şeritlerin `ROUTES` geometrisine göre gerçekten dönmüş eşleşmesi ve slotun `actor.index` değil `spawnZ` olması |
| `tests/integration.test.js` (11) | 3 zorlukta tam maç bitişi, geri sayımda hasar/ateş kilidi, ölüyken ateş, dost ateşi, kafa isabeti, duraklatma dondurması, restart temizliği, HUD durumu, hassasiyet etkisi |
| `tests/ui.test.js` (5) | Gerçek HTML + gerçek HUD bağlaması, reload/boş şarjör, raund sonucu, ayar doğrulama/kalıcılık, tüm kontrol ID'leri |
| `tests/integration.test.js` (14) | + canlı zorluk değişimi, paylaşılan nav grid, `gameSnapshot` sözleşmesi |
| `tests/app.e2e.test.js` (4) | `src/main.js` jsdom'da gerçekten çalıştırılır: menü → ayarlar → kontroller → zorluk → maç → hareket/ateş/reload/silah değiştirme → Esc duraklatma → duraklatma ayarları → maç sonu → yeniden maç → menüye dönüş → yeni maç; F2 ayar paneli; F3 debug katmanı; **çalışma zamanı hatası olmamalı** |
| `tests/render-math.test.js` (4) | Render açı konvansiyonu oyunla birebir: kamera ileri vektörü = `directionFromAngles`, nişan ile çarpışma aynı yönü gösterir, model yönü doğru (bu sınıf hata crosshair'i ters çevirir) |

**`npm run qa`** (scripted playtest → `docs/QA-REPORT.md`): son koşu **35 geçti / 0 uyarı / 0 hata**.
Ölçülenler:

- 3 zorlukta 4 tam maç (QA betiği): hepsi bitti, skorlar 0-3 … 3-2; ortalama raund süresi kolay 28 s /
  normal 24 s / zor ~18 s, en uzun raund 53 s.
- Süre limitiyle karara bağlanan raund: 3 zorlukta toplam **0/47** (17+14+16 raund; 60 maçlık matriste %0–3).
- Bot isabet oranları: kolay ~%15, normal ~%22, zor ~%36 → zorluk **ölçülebilir** biçimde ayrışıyor,
  zor botlar bile atışlarının çoğunu kaçırıyor (LOS + nişan hatası gerçekten çalışıyor).

**`npm run matrix`** (denge matrisi, **40 maç/hücre**, iki bağımsız tohum bloğu → `docs/qa-matrix.json`):
oyuncunun takımının kazanma oranı — otomatik oyuncuyla kolay **%38 / %53**, normal **%38 / %33**,
zor **%33 / %45** (blok 1000 / blok 90000); hareketsiz (idle) oyuncuyla kolay %18 / %25,
normal %18 / %23, zor %13 / %5.

Kazanma oranı mutlak olarak gürültülüdür (±10 puan, tek blokta iki kademe yer değiştirebilir); zorluk
ayrımı bu yüzden **K/D ve raund süresiyle** okunmalı, ikisi de iki blokta tutarlı biçimde sıralı:

| zorluk | K/D (blok 1000 / 90000) | ort. raund süresi (blok 1000 / 90000) |
|---|---|---|
| kolay | 1.31 / 1.71 | 47.4 s / 46.6 s |
| normal | 0.99 / 0.91 | 25.2 s / 25.2 s |
| zor | 0.48 / 0.63 | 18.0 s / 18.3 s |

`node tools/matrix.mjs --matches 40 --seed-base 90000` ile ikinci blok ayrıca koşulur. **Tıkanan raund
oranı kolay %19–22, normal %5–8, zor %0–1** (hedef <%25).

**Tarafsızlık (side bias) testi:** harita 180° dönel simetrik; 5v5 saf bot maçlarında (10 tohumlu maç,
42 karara bağlanmış raund) ALFA 23 / BRAVO 19 raund kazandı (%54.8 / %45.2). Test tohumlu (seeded) olduğu için bu sayı
koşudan koşuya değişmez; ayrıntısı §7b'deki "düzeltilen hatalar" maddelerinde. 1v1 düello testinde 40 maçın 21'i ALFA, 19'u
BRAVO kazandı. Oyuncunun hareketsiz kalması ise **kendi takımını gerçekten zayıflatır** (4 bot 5 bota
karşı kalır) — bu bir denge hatası değil, tasarımın doğal sonucudur ve README'de açıkça yazılıdır.
- Yeniden doğma yok, oyuncu başına raund başına en fazla 1 ölüm, duraklatmada hiçbir aktör değişmiyor,
  canlı zorluk geçişi hasar kurallarını değiştirmiyor, jsdom'da tek `WebGLRenderer` (sızıntı yok),
  çalışma zamanı hatası yok.

`npm run sim` ile de aynı maçlar komut satırından izlenebilir (raund süreleri + bot isabet istatistikleri).

**Bu ortamda yapılamayanlar (dürüstçe):** gerçek GPU'da görsel doğrulama (headless sandbox'ta WebGL ve
tarayıcı otomasyonu yok), Unity Editor doğrulaması, Windows `.exe` build'i. Görsel katman mantık olarak
test edilir (sahne kurulumu, renderer çağrıları, HUD) ama **piksel çıktısı gözle doğrulanmadı**.
Oynanış sizin tarafınızda önizlemede/`dist` dosyasında doğrulanmalı.

---

## 6. Varsayımlar (şartnamede açık olmayan kararlar)

1. **Motor:** Unity yerine Three.js (bkz. platform notu). Mimari ayrımı Unity şartnamesindeki
   `GameManager/MatchManager/WeaponController/BotBrain/HudController` sorumluluklarına birebir eşlenebilir.
2. **Hasar:** 100 can + 50 zırh; zırh gelen hasarın %50'sini yer, tükenince hasar tamamen cana gider.
   Kafa çarpanı ×2.5. Dost ateşi **kapalı** (menüde ve README'de açıkça yazılı) — dost ateşi mermisi
   takım arkadaşından geçer, hasar vermez.
3. **Raund sonu:** sadece tam eleme. Bomba yok. **Tıkanma koruması** olarak 80 saniyelik raund limiti:
   süre dolarsa hayatta kalan sayısı, eşitse toplam can+zırh üstünlüğü kazanır (yoksa beraberlik).
   Bu, "sadece eleme" kuralını bozmadan AI kampını engellemek için eklendi; birincil çözüm ise takım
   süpürmesi (bkz. §7b, madde 6) — süre limiti artık yalnızca güvenlik ağı.
4. **Zorluk:** hasar/stok değerleri her seviyede aynı; yalnızca tepki, nişan hatası, karar hızı,
   koordinasyon, görüş açısı/mesafesi değişir. Zor botlar dahi LOS'a tabidir ve asla %100 isabet etmez.
5. **Silahlar:** tabanca tek tek, tüfek otomatik; her ikisi de raund başında tam cephane ile verilir
   (ekonomi/satın alma yok). Raund başında aktif silah tüfek.
6. **Hareket:** jump/slide yok (istenmedi); koşma ve çömelme var. Kamera gövdeye girmez, eye yüksekliği 1.62 m.
7. **İsim/marka:** başlık "SIFIR NOKTA" geçici çalışma adıdır; tescilli marka iddiası yok.
8. **Kayıt:** yalnızca ayarlar (hassasiyet, ses, FOV, kalite, sarsıntı, zorluk) `localStorage`'da.

---

## 7. Bilinen sınırlamalar

- **Final bir `.exe` yok** — Unity build ortamı bulunmadığı için. Çalıştırma yolu: `dist/SifirNokta.html`
  veya `launcher` betikleri (bir tarayıcı gerektirir; Chrome/Edge önerilir).
- **Görsel doğrulama artık yapılabiliyor** (`npm run visual:setup` bir kez, sonra `npm run visual`): GPU yok
  ama SwiftShader ile gerçek Chromium'da oyun açılıyor, ekran görüntüsü alınıyor ve nişangah **piksel
  olarak** ölçülüyor (sapma: 0 px). Bkz. §10b. Ölçülemeyen: bu ortamın kare hızı ve girdi gecikmesi —
  bunlar donanımı anlatır, oyunu değil.
- Bot AI, şartnamedeki davranış listesinin stabil bir alt kümesidir. **Var:** haritadan türetilen siper
  noktaları (gerçek raycast ile doğrulanmış), çömelip siperden bakma/ateş etme, yaralı takım arkadaşına
  yakın destek. **Yok:** canlandırma/revive, el bombası, sesle yön tayini yapan gelişmiş işitme modeli.
  `BotBrain` yeni durumlar eklemeye uygun ayrılmıştır.
- Destekleme *yakın* bir reflekstir (14 m içi); bot haritanın öbür ucundaki arkadaşına koşmaz. Bu bilinçli
  bir karar: denendiğinde oyuncunun takımını zayıflatıyordu (bkz. §7c).
- Görsel kalite "yüksek" ayarında gölge açılır; entegre GPU'larda FPS düşebilir (kalite ayarı düşürülebilir).
- Şerit renk kodlaması (kuzey sıcak / güney soğuk / orta pirinç) bir *yön* yardımcısıdır, haritayı
  öğrenmenin yerine geçmez. Renk körlüğü olan oyuncular için tek ayırt edici işaret bu değildir:
  şeritlerin konumu (kuzey/orta/güney) ve genişliği de sabittir.
- Ses sentetik olduğu için gerçek silah kayıtları kadar zengin değil. Katmanlı sentez ve reverb bunu
  büyük ölçüde kapattı ama kayıt (sample) kalitesine ulaşmıyor. Ölçülebilir kısmı §10c'de.
- Pointer lock tarayıcı tarafından Esc ile bırakılırsa oyun otomatik duraklar (tarayıcı davranışı).
- **Erişilebilirlik kısmi:** menüler/diyaloglar axe-core WCAG 2.1 A/AA taramasından 0 ihlalle geçiyor
  (landmark, dialog rolü, canlı bölgeler). Ancak bir FPS'in oynanışı fare+klavye gerektirir; ekran
  okuyucuyla oynanabilir bir nişancı deneyimi hedeflenmedi. Gamepad desteği kapsam dışı.
- **Hareketsiz oynayan kazanmaz:** oyuncu ölü/hareketsiz kaldığında takımı 4 botla 5 bota karşı kalır;
  bu yüzden "hiçbir şey yapmama" oranı düşüktür (bkz. `npm run matrix`). Bilinçli bir tasarım sonucudur.

---

## 7b. Bu sürümde bulunan ve düzeltilen gerçek hatalar

Flaky (kararsız) testleri kovalarken ortaya çıkan, oynanışı doğrudan etkileyen hatalar. Hepsi için
regresyon testi eklendi (`tests/ai.test.js`), yani bir daha sessizce geri gelmiyorlar.

1. **Tohumlu maçlar deterministik değildi.** Silah yayılması ve geri tepmesi küresel `Math.random()`
   kullanıyordu; `createGame({ seed })` verilse bile maç koşudan koşuya değişiyordu. Artık tüm rastgelelik
   maç RNG'sinden (bot başına ayrı akış) geçiyor → aynı tohum aynı maç. Bu, denge ölçümlerinin ve
   testlerin tekrarlanabilir olmasının ön koşuluydu.
2. **Taraf kayırması (side bias) gerçekti.** Botlar her tick `match.actors` sırasına göre güncelleniyordu;
   ALFA her zaman önce davranıp BRAVO'nun yeni pozisyonunu görüyor, BRAVO bir tick geriden geliyordu.
   60 maçta ALFA raundların %57.7'sini kazanıyordu. Güncelleme sırası artık tick başına dönüşümlü →
   %49.4 (ve test artık deterministik olduğu için dalgalanmıyor: 42 raundun 23'ü ALFA).
3. **Botlar spawn koridorunda birbirini kilitleyebiliyordu.** Takım arkadaşına değen bot birebir geri
   itiliyor, ilerleme sıfırlanıyordu; 20 saniyede 1 metre yol alan botlar vardı. Ayrışma artık tek yönlü
   (hedefe uzak olan çekilir) → takım kapılardan sırayla geçiyor.
4. **ADVANCE her 1.2 saniyede lane hedefine geri dönüyordu.** Bu yüzden siper/süpürme/kovalama gibi tüm
   "detour" hedefleri ilk tick'te siliniyor, botlar iki nokta arasında gidip geliyordu. Detour artık
   süreli bir kilit (`detourUntil`) ile korunuyor.
5. **Lane sayacı hatalı ilerliyordu.** Hem `INVESTIGATE`'ten çıkarken hem de herhangi bir hedefe varınca
   sayaç artıyordu; bot bir raundda lane listesini tüketip hedefsiz kalıyordu. Artık sayaç yalnızca lane
   noktasına gerçekten varınca artıyor.
6. **Sessiz raundlar süre limitine takılıyordu.** İki takım da kendi lane'ini yürüyüp karşı köşede kamp
   kuruyordu; tıkanan raund oranı %26'ydı. Takım halinde süpürme (squad sweep) eklendi: temas yokken
   takım tek bir arama bölgesine birlikte gidiyor, 26 saniyeden sonra iki takım da haritanın merkezine
   süpürüyor (sadece harita bilgisi — düşmanın canlı pozisyonu asla kullanılmıyor). Tıkanma **%26 → %1**.

Bu maddeler aynı zamanda şartnamedeki "zorluk sadece tepki/nişan/karar/koordinasyonu değiştirir, hile
görüş yok" kuralının korunduğunu gösterir: düzeltmelerin hiçbiri botlara ek bilgi vermedi, sadece
kendi harita bilgilerini doğru kullanmalarını sağladı.

### 7b-bis. Nişan/şerit turunda eklenenler

7. **Şerit ataması iki takımda farklı şerit *şekilleri* üretiyordu.** `map.js`'teki ayna fonksiyonu,
   180° dönüşte şeridin de döneceğini hesaba katmıyordu: A'nın `north` koridoru (z = −16) dönüşte B'nin
   `south` koridoruna (z = +16) düşer, ama atama B'ye *aynı* şeridi veriyordu. Üstelik `bot.js` bu
   fonksiyonu hiç çağırmıyor, kendi özel `LANE_PATTERN`/`laneForSlot` kopyasını `actor.index` ile
   kullanıyordu. Sonuç: ALFA `north×2, south×1, mid×1` yürürken BRAVO `mid×2, south×2, north×1`
   yürüyordu — iki takım aynı *sayıda* şerit kapladığı için hiçbir test bunu yakalamıyordu.
   Şerit ataması artık `map.js`'te tek yerde, slot `spawnZ`'den türetiliyor, test `ROUTES`'un gerçek
   geometrisine karşı dönmüş eşleşmeyi doğruluyor (mutasyonla sınandı: eski hâle dönünce test kırılıyor).
8. **Şerit dağıtım testi totolojiydi.** Test, `laneForMirroredSlot('B', s)`'yi
   `laneForMirroredSlot('A', mirrorSlot(s))` ile karşılaştırıyordu — ama B tarafı zaten *tanım gereği*
   böyle hesaplandığı için bu eşitlik hiçbir zaman bozulamazdı. Aynı şekilde "iki takım aynı şerit
   karışımına sahip olmalı" iddiası da yanlıştı: dönel simetride `north` sayısı `south` sayısına eşit
   olmalı, birbirine değil. İkisi de düzeltildi.
9. **Çömelirken nişan noktası tek karede sıçrıyordu.** `aimPoint` `target.crouch > 0.5` eşiğiyle iki sabit
   yükseklik (1.12 m / 0.78 m) arasında atlıyordu. `crouch` ~100 ms'de 0→1 lerp ettiği için, hedef tam
   eşiği geçtiği karede botun nişan noktası ~34 cm zıplıyor ve o karede ne kadar iyi takip ediyor olsa da
   ıskalıyordu (ölçülen: tek adımda 12.2 cm). Yükseklikler artık `PLAYER.chestHeight` /
   `PLAYER.crouchChestHeight` olarak config'de ve lerp ile geçiliyor.
10. **`aimPoint` ve denge testindeki nişan yükseklikleri çift yazılmıştı.** Bot nişanı, vuruş hacimleri ve
    `tools/matrix.mjs`'teki otomatik oyuncu aynı gövde yüksekliğini üç ayrı yerde sabit sayı olarak
    taşıyordu; biri değişince diğerleri sessizce kayıyordu. Hepsi tek kaynaktan (`PLAYER`) okuyor.
11. **ADS isabet bonusu arpacıktan önce geliyordu.** Oyuncu ADS'e bastığı karede yayılma konisi tam
    nişanlı değere düşüyordu, ama arpacık görsel olarak ~200 ms'de yerine oturuyordu (viewmodel lerp'i).
    Yani oyun, oyuncuyu göremediği bir nişanın ödülüyle ödüllendiriyordu — merkezde olmayan nişangahla
    aynı sınıf hata. `pc.adsBlend` eklendi: koni ve arpacık artık aynı eğriyi kullanıyor, yarı nişanlı
    yarı yayılma demek. `tryShoot` hem `ads` (botlar için boolean) hem `adsBlend` (oyuncu için 0..1)
    kabul ediyor. `adsTarget` alanı da ölü kod olarak duruyordu, kaldırıldı.
12. **PWA kurulumu `npm run dev`'de çalışmıyordu, üretimde çalışıyordu.** İki ayrı hata üst üste
    biniyordu:
    - Manifest ve service worker `src/pwa/` içinde duruyor, dev sunucusu ise yalnızca depo kökünü
      servis ediyordu → `/manifest.webmanifest` ve `/sw.js` **404**.
    - Kayıt `new URL('./sw.js', import.meta.url)` ile yapılıyordu; bu *modülün* dizinine göre çözülür,
      yani dev'de `/src/ui/sw.js` isteniyordu. Üstelik servis edilse bile bir worker'ın kapsamı kendi
      dizinidir (`/src/ui/`), oyun sayfasını asla kontrol etmezdi. Derlenmiş sitede çalışmasının tek
      sebebi esbuild'in her şeyi `sw.js`'in yanına koymasıydı — hatayı sürüm anına kadar saklayan
      tam da bu farktı.

    Düzeltme: kayıt belgeye göre çözülüyor (`document.baseURI`) ve kapsam belge dizini olarak açıkça
    veriliyor; dev sunucusu iki dosyayı sanal yolla köke eşliyor (`src/pwa/` tek kaynak olarak kalıyor)
    ve `Service-Worker-Allowed: /` başlığını gönderiyor. Üç regresyon testi eklendi, üçü de mutasyonla
    sınandı.
13. **Denge matrisi tek tohum bloğuna bağlıydı.** `tools/matrix.mjs` her koşuda aynı 1000 tabanlı tohumları
    kullanıyordu, yani "zorluk kademeleri monoton" iddiası tek bir blokla sınanıyordu ve blok yeniden
    üretilemiyordu. `--seed-base` eklendi; zorluk ayrımının kazanma oranı yerine K/D ve raund süresiyle
    okunması gerektiği de bu sırada ölçüldü (kazanma oranı bloklar arası ±10 puan oynuyor).

---

### 7b-ter. Sahne neden siyahtı (ölçülerek bulundu)

Ekran görüntülerinde sahne neredeyse siyahtı. Üç ayrı sebep vardı ve **hiçbiri hata olarak
görünmüyordu** — oyun çalışıyordu, sadece göremiyordun.

1. **Yüzey albedosu çok düşüktü.** Duvarlar `0x35474f`, zemin `0x1b262c` idi. Bu renkler tam
   aydınlatmada bile lineer ~0.08 döndürüyor; ton eşlemeden sonra bu 21/255 demek.
2. **three.js artık fiziksel ışık birimleri kullanıyor.** r155'ten beri Lambert BRDF'i ışığı π'ye
   bölüyor ve şiddetler kandela benzeri birimde. Eski `1.15 / 1.5 / 0.35` değerleri bu yüzden
   eskisinin yaklaşık **üçte biri** kadar ışık veriyordu. Sahne under-exposed'dı; ton eşlemesi
   hiçbir şeyi öldürmüyordu. Ölçüm: şiddetleri 3 katına çıkarmak medyanı 25 → 66/255 yaptı ve
   hiçbir piksel kırpmadı.
3. **Gökyüzü yoktu ve gökyüzü kubbe shader'ı renk uzayını atlıyordu.** Haritanın tavanı yok
   (duvarlar 3.5 m), yani her karenin üst kısmı boş arka plan rengiydi. Kubbe ekledikten sonra bile
   üst yarı 7/255'te kaldı: elle yazılmış `ShaderMaterial`'a three.js ton eşleme ve sRGB dönüşümünü
   **otomatik enjekte etmiyor**. Lineer 0.05, sRGB framebuffer'a doğrudan yazılınca 0.24 yerine 0.05
   olarak görünüyor — beş kat karanlık. `#include <tonemapping_fragment>` + `#include <colorspace_fragment>`
   eklemek bunu çözdü.

Ayrıca elde tutulan silah `0x232c31` idi ve kameraya bağlı olduğu için oda ışıklarından pay almıyordu:
tam siyah bir silüet. Kameraya bağlı iki kısa menzilli dolgu ışığı eklendi (şiddetler candela
olduğu için 0.55 ve 0.14 — 5.5 denendi ve silah krom gibi patladı).

**Önce / sonra (canlı kare, 1280×720):**

| Ölçüm | Önce | Sonra |
|---|---|---|
| Medyan parlaklık (p50) | 21/255 | **53/255** |
| En parlak piksel | 47/255 | 142/255 |
| Saf siyah piksel oranı | %7.4 | **%0.0** |
| Gökyüzü bandı medyanı | 7/255 | 52/255 |
| Gökyüzüne bakarken p50 | 7/255 | 28/255 |

Bunların hepsi `npm run visual` içinde **eşik olarak** duruyor (19 adım). Eşikler mutasyonla
sınandı: ışıkları eski değere döndürmek 2 adımı, gökyüzü renk uzayı düzeltmesini silmek 1 adımı
kırıyor.

**Dürüst sınır:** bu ölçümler "sahne görünür" diyor, "sahne güzel" demiyor. Işık şiddetlerini
beğenip beğenmeyeceğin hâlâ senin ekranına bakıyor. Grafik kalitesi "yüksek" ayarında gölgeler
açıldığı için bu değerler orada biraz farklı olacak.

## 7c. Siper ve takım desteği: ne denendi, ne işe yaradı

Bu iki davranış eklenirken üç kez geri alınan yaklaşım oldu; ölçümler olmadan fark edilmeyecek bir
denge tuzağı var, o yüzden buraya yazıyorum.

| Deneme | Sonuç (60 maç/hücre matris) | Karar |
|---|---|---|
| Siper `ENGAGE` durumundan `return` ediyordu | Botlar çatışmayı tamamen bıraktı; zorluk sırası bozuldu (kolay %97 kazanma) | **Reddedildi** — siper bir *duruş*, ayrı bir durum değil |
| Siper her temasta tetikleniyordu | Sağlıklı botlar da saklandı, tıkanan raund %2 → %28 | **Reddedildi** — yalnızca yaralı/şarjörsüz bot sipere girer |
| Destek: harita çapında yardıma koşma | Botlar kendi lane'ini bıraktı, takım zayıfladı (normal auto %52 → %90) | **Reddedildi** — destek 14 m içi, ileri yönlü, bekleme süreli |
| Destek: yakın + yalnızca boştayken + soğuma | Etki nötr (istatistiksel olarak ayrışmadı) | **Kabul** — davranış var, dengeyi bozmuyor |
| Siper: yaralıyken, en fazla ~3 s, peek/hide döngüsü, nokta paylaşımı | Kolayda tıkanma %2 → %10, normal %0 → %3, zor %1 | **Kabul** |

Ölçülen son durum (60 maç/hücre, 360 maç): kazanma oranı kolay **%70** → normal **%52** → zor **%40**
(otomatik oyuncu); tıkanan raund kolay %12–14, normal %3, zor %0. Taraf dengesi 40 tohumlu 5v5
bot-vs-bot maçında **%50.9 / %49.1**.

İki teknik not, ikisi de hata ayıklarken ortaya çıktı:

1. **Siper noktaları ızgaraya oturtulurken simetri bozuluyordu.** Navigasyon ızgarasında x=0'da hücre
   merkezi yok (ızgara `-31..31`, hücre 1 m), bu yüzden ayna eksenindeki bir nokta hep +0.5'e kayıyor ve
   siper listesi asimetrik hâle geliyordu (76/156 noktanın aynası kayıp). Çözüm: her nokta aynasıyla
   **çift** olarak ele alınıyor; biri oturtulamıyorsa ikisi birden düşüyor. Sonuç: 62 nokta, tam simetrik.
2. **`followPath` boş yolda "vardı" dönüyor.** Siper mantığı bunu "siperdeyim" sanıp noktayı 5 m
   uzaktayken bırakıyordu. Mesafe kontrolü artık yol kontrolünden önce.

---

## 8. Unity'ye taşıma notları

Bu proje bilerek taşınabilir bir iskelet bırakır. Eşleme:

| Bu proje | Unity karşılığı |
|---|---|
| `core/config.js` | `ScriptableObject` (`WeaponData`, `DifficultyProfile`, `MatchSettings`) |
| `core/match.js` | `MatchManager` + `RoundManager` (aynı durum makinesi, aynı idempotent kurallar) |
| `core/weapon.js` | `WeaponController` (+ aynı formüller: cadence, spread, recoil) |
| `core/damage.js` | `HealthArmor` (formül birebir aynı) |
| `core/combat.js` | `Physics.Raycast` / `SphereCast` (hitbox: kafa ayrı collider) |
| `core/navgrid.js` | `NavMeshAgent` + `NavMesh.SamplePosition` (rota noktaları aynı) |
| `core/bot.js` | `BotBrain` / `BotPerception` / `BotCombat` (aynı zorluk profilleri) |
| `ui/hud.js` | Canvas/UI Toolkit `HUDController` |
| `tests/*.test.js` | NUnit/Unity Test Framework (mantık saf olduğu için neredeyse birebir taşınabilir) |

Sayısal denge verisi (`config.js`) ve tüm kurallar motordan bağımsızdır; Unity tarafında yeniden
tasarım değil, yeniden *uygulama* gerekir.

---

## 9. Denge ayar paneli (F2)

Oyun içinde `F2` ile açılan [lil-gui](https://github.com/georgealways/lil-gui) paneli, aşağıdaki değerleri
**çalışan maça** anında yazar:

- Oyuncu canı / zırhı, kafa çarpanı, zırh absorbsiyonu
- Kolay / Normal / Zor nişan hatası (derece) ve maç zorluğu (anında tüm botlara uygulanır)
- Tüfek/tabanca hasarı ve atış hızı (rpm)

"Değerleri konsola yaz" düğmesi seçili değerleri `src/core/config.js` içine taşıyabileceğin JSON olarak
yazdırır; "Varsayılana dön" fabrika denge değerlerini geri yükler. Panel yalnızca geliştirici kolaylığıdır,
oyunun kural setini değiştirmez (hasar formülü, LOS ve zorluk mantığı aynı kalır).

## 10. Proje içi araçlar

| Komut | Ne yapar |
|---|---|
| `npm run dev` | Statik dev sunucusu (host/origin allowlist yok, önizleme uyumlu) |
| `npm test` | 282 headless test |
| `npm run lint` | ESLint (hata odaklı) |
| `npm run a11y` | Erişilebilirlik denetimi (axe-core, WCAG 2.1 A/AA) — şu an **6 ekran / 0 ihlal** |
| `npm run visual` | Gerçek Chromium'da oyunu açar: 33 adım + nişangah/girdi/pozlama/harita/kariyer/çarpma/ölüm ölçümü (§10b) |
| `npm run visual:setup` | Görsel test tarayıcısını kurar (`.playwright/`, ~200 MB, tek seferlik) |
| `npm run audio` | Her sesi çevrimdışı render edip ölçer: tepe/RMS/uzunluk/merkez frekans (§10c) |
| `npm run audio:live` | Oyunu açar, gerçek bir tur oynar ve mikserin ne çaldığını raporlar (§10c) |
| `npm run verify` | lint + test + a11y + build |
| `npm run build` | Tek dosya offline build (`dist/SifirNokta.html`) |
| `npm run build:site` | Kurulabilir site (PWA) → `dist/site/` (manifest, sw, ikonlar, `_headers`) |
| `npm run preview:site` | `dist/site` önizlemesi (port 8080) — "Yükle" düğmesini burada görürsün |
| `npm run icons` | Uygulama ikonlarını üret (`icons/*.png`, `build/icon.ico`) |
| `npm run app` | Electron masaüstü penceresinde çalıştır |
| `npm run app:dist` | Windows kurulum + portable `.exe` üret (`dist-app/`) |
| `npm run qa` | Senaryolu playtest + `docs/QA-REPORT.md` (JSON: `node tools/qa.mjs --json`) |
| `npm run matrix` | Denge matrisi: zorluk × oyuncu modu, kazanma/tıkanma oranları (`docs/qa-matrix.json`). Güncel tablo: 60 maç/hücre, 360 maç |
| `npm run sim -- <zorluk> <seed> <maç>` | Headless maç simülatörü |

İncelenip değerlendirilen GitHub kaynakları (ve bilinçli olarak alınmayanlar): [`docs/KAYNAKLAR.md`](docs/KAYNAKLAR.md).

### 10b. Gerçek tarayıcıda görsel + hissiyat testi

jsdom testleri oyunun **mantığını** doğrular ama WebGL'e hiç dokunamaz; bu yüzden "oyun gerçekten çiziyor
mu, nişangah nerede" soruları uzun süre cevapsız kaldı. Artık cevaplanıyor:

```bash
npm run visual:setup    # tek seferlik, ~200 MB → .playwright/
npm run visual          # 13 adım + ölçümler → screenshots/
npm run visual -- --difficulty hard --out /tmp/zor
npm run visual -- --json
```

**Tarayıcı neden npm'den geliyor.** Bu ortam yalnızca `registry.npmjs.org` ve `pypi.org`'a erişebiliyor.
Playwright'ın olağan indirmesi (`cdn.playwright.dev`) ve `apt-get` ikisi de denendi ve başarısız oldu —
`@sparticuz/chromium` ise Chromium binary'sini **npm tarball'ının içinde** taşıyor, yanında ihtiyaç
duyduğu AL2023 `.so` setiyle. `tools/visual-setup.mjs` ikisini açar, `LD_LIBRARY_PATH`'i ayarlar ve
kurulumun çalıştığını `chromium --version` ile doğrular (sessizce bozuk tarayıcı kurmaktan iyidir).

Render: GPU yok, ama `--use-angle=swiftshader` yazılımsal **WebGL 2.0** sağlıyor.

**Ölçülenler** (son koşu, 13/13):

| Adım | Sonuç |
|---|---|
| WebGL bağlamı | WebGL 2.0, 1280×720 |
| Menü / zorluk / HUD | açılıyor, menüler kapanıyor |
| **Nişangah katmanı merkezde** | **sapma dx=0.00 px, dy=0.00 px** |
| **Haç kolları simetrik** | merkez dx=0.00 px, dy=0.00 px (4 kol) |
| Fare bakışı doğrusal | 100×1 = 10×10 = `0.038397 rad` (ivme yok) |
| Bakış açısı sınırı | ±88° |
| ADS eğrisi | kare kare 0.70 → 1.0 (sıçrama yok) |
| Çömelme eğrisi | 0.45 → 1.0 (lerp çalışıyor) |
| F3 katmanı | canlı veri (1.4 s arayla iki okuma farklı) |
| Konsol | hata yok |

Nişangah ölçümü mutasyonla sınandı: katmanı `calc(50% + 16px)`'e kaydırdığımda (orijinal hatanın
birebir aynısı) test **dx=16px sapma** diyerek kırılıyor.

**Ölçülemeyenler — ve neden.** Bu ortam 2 vCPU ve GPU'suz; oyun burada **~2 FPS** çalışıyor. Yani:

- **Kare hızı** burada ölçülmez. Ölçülse bile donanımı anlatır, oyunu değil.
- **Girdi gecikmesi** aynı sebeple anlamsız (her kare ~400 ms).
- **Hissiyat** (kamera ivmesinin rahatsız edip etmediği, silah sallanmasının abartılı olup olmadığı)
  hâlâ insan gerektiriyor. Ölçtüğüm şey *eğrinin doğru olduğu*, *hoş olduğu* değil.

Bu ayrımı yazıyorum çünkü "test ediyorum" demek "beğeneceksin" demek değil; ikincisini iddia etmek
dürüst olmaz.

**Ortam tuhaflığı (kayda değer).** Sayfa ön plandaki pencere olmadığı için pointer lock reddediliyor ve
oyun kendini duraklatıyor. Test, oyunun kendi durumu üzerinden duraklamayı kaldırıyor ve **sabit
timeout yerine turun `live` fazına geçmesini bekliyor** — çünkü 2 FPS'te oyun saati duvar saatinden ~7
kat yavaş ilerliyor. Sabit beklemeyle yazılmış bir test burada sahte hata verirdi.


### 10c. Ses: nasıl yapıldı, nasıl ölçüldü

Ses dosyası yok, indirilen örnek yok. Her ses `src/ui/audio.js` içinde **sıfırdan sentezleniyor**:
osilatörler, filtrelenmiş gürültü ve elle üretilmiş bir oda impulse'ı (konvolüsyon reverb).

**Neden katmanlı.** İlk sürümde her silah "bir gürültü patlaması + bir bip" idi; bu yüzden bütün silahlar
aynı silahın farklı ses seviyesi gibi duyuluyordu. Şimdi her atış en az dört katman:

| Katman | Ne | Süre |
|---|---|---|
| crack | süpersonik çıtırtı, geniş bant | ~20 ms |
| body | göğüste hissedilen gövde, alçak bant | ~60 ms |
| action | silahın mekanik çevrimi, **inharmonik** metalik kısmi tonlar | ~10 ms |
| tail | oda cevabı (reverb) | 200–600 ms |

Mekanik seslerdeki kısmiler bilinçli olarak harmonik değil (1, 2.32, 3.71, 5.13 …). Tam sayı katları
kullanılsaydı bir akor duyulurdu — gerçek çelik plaka/kutu öyle tınlamıyor.

**Mesafe.** Sadece ses seviyesi düşmüyor: havada tiz önce kaybolduğu için mesafeye bağlı bir low-pass
de var (`16000 / (1 + d/5.5)` Hz). 40 m'deki bir atış bu yüzden "kısık çıtırtı" değil, "uzaktan gümbürtü"
olarak duyuluyor. Buna ek olarak yakın/uzak oranına göre dry/wet dengesi değişiyor.

**Yön.** `soundPlacement(dinleyici, kaynak, yaw)` saf geometri: `pan = sin(rel)`, `rel = atan2(dx, -dz) - yaw`.
`StereoPannerNode` ile uygulanıyor. Bu fonksiyonun işareti yanlış olsa her düşman yanlış tarafta
duyulurdu; bu yüzden ayrı test ediliyor (`tests/audio.test.js`, 11 vaka + pan işareti süpürmesi).

**Yeni sesler bu turda:** üç ayrı adım sesi (yürü/koş/eğil), üç aşamalı şarjör değişimi
(`reload_start` → `reload_mag_out` → `reload_mag_in` → `reload_end`), düşman şarjör sesi (duvardan,
filtrelenmiş, yönlü), ve ıskalayan kurşunun ıslığı (aşağı süpüren dar bant = Doppler).

#### Nasıl ölçülüyor

Ses "kulağa hoş geliyor" ile doğrulanamaz, ama üç şey ölçülebilir: **var mı, taşıyor mu, ayırt edilebiliyor mu.**

`npm run audio` her sesi gerçek Chromium'da `OfflineAudioContext` ile 5 kez render edip ortalamasını alır:

```
ses                 peak      rms      uzunluk   merkez    sonra     flatness
shot_rifle         -13.5dB  -33.4dB   0.378s    7007Hz   1628Hz   0.623
shot_pistol        -16.5dB  -39.1dB   0.172s   10229Hz   3716Hz   0.770
tail               -21.8dB  -36.8dB   0.461s     530Hz    389Hz   0.012
step_walk          -39.5dB  -52.8dB   0.152s    1048Hz   1121Hz   0.075
step_sprint        -32.0dB  -51.2dB   0.452s    1492Hz   1619Hz   0.075
step_crouch        -50.2dB  -63.4dB   0.074s    4008Hz   3312Hz   0.332
whizz              -27.2dB  -47.0dB   0.320s    8202Hz   3564Hz   0.581
...
82/82 kontrol geçti
```

Kontroller karşılaştırmalı, çünkü asıl hata "ses yok" değil "sesler birbirine benziyor":

- Hiçbir ses sessiz değil (> -55 dBFS) ve hiçbiri kırpmıyor (< -1 dBFS).
- Koşma adımı yürüyüşten **en az 3 dB** yüksek; eğilme adımı yürüyüşün **6–20 dB** altında
  (fazlası sessiz = bozuk, azı = gizlilik yok).
- Atış, adımdan **en az 2 kat** daha tiz (merkez frekans).
- Tüfek ve pistol birbirinden ayrı ölçülüyor (yüksek/alçak dengesi bilinçli farklı).
- Şarjör girme/çıkma sesleri farklı.
- **Iskalayan kurşun aşağı süpürüyor**: sesin sonundaki merkez frekans başlangıcın %60'ının altında.
  Bu kontrolü yazarken ölçüm penceresi sesin *kuyruğuna* denk geliyordu ve düzleştirilmiş bir süpürme
  bile "geçiyordu" — pencere sabit 60 ms ofsete taşındı, sonra mutasyonla doğrulandı.

Bu eşiklerin hepsi mutasyonla sınandı: yürüyüşü koşmaya eşitlemek, süpürmeyi düzleştirmek ve crouch'u
normal adım yapmak testleri **kırıyor** (1/82, 1/82, 1/82). Yani testler gerçekten koruyor.

#### Canlı doğrulama

`npm run audio:live` oyunu açar, `OYNA → NORMAL → MAÇI BAŞLAT` ile gerçek bir tur başlatır, yürür/koşar/
eğilir/ateş eder/şarjör değiştirir ve **mikserin gerçekten ne çaldığını** kaydeder. Son koşu:

```
✓ walk footsteps fire — 14 adet
✓ sprint footsteps fire — 4 adet
✓ crouch footsteps fire — 1 adet
✓ the old generic step is gone
✓ a reload emits its separate stages — reload_start, reload_mag_out, reload_mag_in, reload_end
✓ enemy fire carries a stereo position — 41 adet
✓ some of it is not dead centre — 41/41 yanda
✓ enemy fire carries a distance — ortalama 41.0 m
12/12 kontrol geçti
```

`enemy_reload` ve `whizz` bu turda denk gelmedi (2 FPS'te 90 oyun-saniyesi kısa); onlar için tarayıcıya
güvenmek yerine **kafasız simülasyondan deterministik test** var: 180 oyun-saniyesinde 82 whizz ve 7
düşman şarjörü üretiliyor ve test bunları istiyor. Koddan çıkarınca test kırılıyor.

**Sınır:** kulağa nasıl geldiğini ölçemiyorum. Ölçtüğüm şey sesin var olduğu, seviyesinin doğru olduğu
ve diğer seslerden ayırt edilebildiği. Beğenip beğenmeyeceğin hâlâ senin kulağına bağlı.


### 10d. Taktik harita ve pusula

Harita 64 × 44 m ve üç şeritli. Bu turdan önce nerede olduğunu bilmenin tek yolu düzeni ezberlemekti:
üç şerit içinden bakınca birbirinin aynısı, HUD'da nişangâhtan başka hiçbir şey yok.

**Ne gösteriyor**
- Şerit bantları: kuzey sıcak, güney soğuk, orta pirinç — **zemindeki şeritlerle aynı renkler**
  (`render/scene.js` LANE_STRIPS). Harita dünyayla çelişirse haritasızlıktan kötüdür.
- Kendi konumun: yönü gösteren bir ok.
- Takım arkadaşların: her zaman tam konum.
- Düşman temasları: **soluklaşan** kırmızı halkalar. Taze temas parlak, 6 saniyelik olan hayalet.
  Bu solma keyfi değil — "ne kadar güveneyim" sorusunun cevabı.
- Konum etiketi: `ALFA · KUZEY–ORTA ARASI`. Şeritler arasındayken hangi ikisi arasında olduğunu
  söylüyor; ilk sürüm "ŞERİT DIŞI" diyordu, doğruydu ama işe yaramazdı — üstelik iki spawn da
  şeritler arasında olduğu için oyuncunun gördüğü ilk şey buydu.

**Pusula** kayan bir şerit + sabit iğne. Dört ana yönde de merkezdeki harf doğru (test ediliyor).
Yön, kameranın `yaw` değerinden geliyor: yaw 0 = kuzey (−z), pozitif yaw sağa.

#### Neden bu bir duvar hack'i değil

Minimap'in en kolay yanlış yapılışı `match.actors`'ı doğrudan çizmektir: o zaman harita her düşmanı,
kimse görmeden gösterir. Burada temaslar ayrı bir kaynaktan geliyor ve yalnızca üç yolla oluşuyor:

1. **Sen vurdun** — nereye vurduğunu bilirsin.
2. **Sana ateş edildi** — nereden geldiğini bilirsin (vursa da vurmasa da).
3. **Takım arkadaşın gördü** — `canSee()` yani görüş konisi + görüş hattı + görüş mesafesi.

Yani oyuncu, botların sahip olduğundan fazla bilgi almıyor. Bu test ediliyor: 45 saniyelik gerçek bir
maçta her tick'te her temasın gerçek bir aktör olduğu, **düşman** olduğu ve **canlı** olduğu doğrulanıyor.

Bu arada gerçek bir hata çıktı: aynı tick'te hem temas işaretlenip hem düşman ölebiliyordu, o zaman ceset
6 saniye haritada kalıyordu — nişan alabileceğin bir hedef gibi görünüyordu. Her tick sonunda
ölü temaslar süpürülüyor.

#### Ölçüm

`npm run visual` içinde iki kontrol (22 adım):
- **Minimap çiziyor** — canvas'ın boş olmadığı piksel sayımıyla doğrulanıyor (mutasyon: `drawMinimap`
  çağrısını silmek → %0 dolu → adım kırılıyor).
- **Pusula dört yönde doğru** — iğnenin altındaki harf K/D/G/B ile karşılaştırılıyor
  (mutasyon: yönü ters çevirmek → 2 yön yanlış → adım kırılıyor).

**Bu turda bulunan iki test hatası:**
1. Pusula kontrolü sabit `320 ms` bekliyordu; 2 FPS'te HUD bir sonraki karede güncellendiği için
   **kararsızdı** — tek başına geçiyor, tam koşuda ara sıra düşüyordu. Koşula bağlı beklemeye çevrildi.
2. Mutasyon çöktüğünde test tümden iptal oluyordu (15 sn timeout). Artık başlık gelmezse bu *başarısız
   bir adım* olarak raporlanıyor — bozuk pusula "pusula yanlış" demeli, "test çöktü" değil.

**Dürüst sınır:** haritanın *okunabilir* olduğunu ölçtüm (boş değil, yönü doğru). *Güzel* olduğunu ya da
168 px'te yeterince rahat okunduğunu değil — o senin ekranına bakıyor.


### 10e. Kariyer istatistikleri

Bir maç bitiyordu, yedi sayı gösteriyordu, sonra her şey unutuluyordu. "Daha iyi oluyor muyum?" sorusunun
cevabı yoktu, geçmiş yoktu, ve zorluk ayarının o maçtan başka bir anlamı yoktu.

`src/core/career.js` saf bir birleştirme fonksiyonu + tek bir depolama adaptörü. İlginç kısım birleştirme
olduğu için test edilebilir: **28 test**, çoğu mutlu yol değil **bozuk girdi** hakkında.

- Maç, galibiyet/mağlubiyet/berabere, öldürme, ölüm, kafa, atış, isabet, hasar, raund, süre — ve
  **zorluk bazında ayrı** sayaçlar.
- Son **10 maç** geçmişi. Sınırsız bir günlük, localStorage'ın yazamaz hale gelmesinin en yaygın yoludur.
- Okurken her şey doğrulanıyor: bu veri elle düzenlenebilir, kota hatasıyla yarıda kesilebilir, eski
  sürümden kalmış olabilir, ya da tarayıcı erişimi tamamen engelleyebilir. Bozuk dosya "henüz kariyer yok"
  durumuna düşer — asla çökmez, asla ekranda NaN göstermez, asla %100 üstü galibiyet oranı iddia edemez.
- Değişmezler **onarılıyor**, gösterilmiyor: `isabet ≤ atış`, `kafa ≤ isabet`, `galibiyet ≤ maç`.

#### Yol boyunca bulunan sessiz yalan

`game.stats` her raund başında sıfırlanıyor. Yani maç sonu ekranındaki **"İsabet"** aslında *sadece son
raundun* isabetiydi — son raundu iyi geçen herkesi sessizce pohpohluyordu. `matchStats` eklendi; yalnızca
yeni maç başlarken sıfırlanıyor.

Bu, kariyerin neden önemli olduğunu da gösteriyor: yanlış sayıyı kaydetmek, kaydetmemekten kötüdür.

#### Ekranda bulunan üç hata

1. `careerSummary` yalnızca oranları döndürüyordu, ham sayaçları değil. Sonuç: binlerce atışı olan bir
   kariyerde K/D, isabet ve kafa isabeti **"—"** gösteriyordu. Birim testleri yakalamadı; tarayıcıda
   gerçek bir kariyer yüklemek yakaladı.
2. Kariyer paneli laptop ekranından uzundu ve hem üstten hem alttan taşıyordu — **başlık ve GERİ düğmesi
   ikisi de erişilemezdi.** Ekran artık kaydırılıyor.
3. Geçmiş satırları depolanmış veri üzerinde `h.kd.toFixed(2)` çağırıyordu; elle düzenlenmiş bir kayıt
   tüm ekranı çizen döngünün içinde çökerdi.

### 10f. Çarpma efektleri ve ölüm animasyonu

Duvara sıkmak tek bir karenin çeyrek saniyede sönmesini üretiyordu ve geride hiçbir şey bırakmıyordu.
Bir botu öldürmek cesedi aynı karede yok ediyordu. İkisinde de dünya hiçbir şey olmuş gibi davranmıyordu.

**Kurşun izleri** iki katmanlı: açık renkli toz halkası + koyu çekirdek. Tek katman denendi ve **ekranda
ölçüldü**: duvarlar zaten koyu mavi-gri olduğu için `0x14181c` bir leke tamamen görünmezdi. Halka, hasar
olarak okunan şey.

**Kıvılcımlar** oyun tick'inde simüle ediliyor, renderer'da değil — böylece yay oyun durumunun parçası ve
bir test düştüklerini doğrulayabiliyor.

#### Testlerin bulduğu iki gerçek hata

1. **Zemine sıkınca kıvılcımlar aşağı uçuyordu.** Zemin yüzey normali aşağı bakar; onu harfi harfine
   kullanmak kıvılcım patlamasının tamamını haritanın altına gömüyordu — yere sıkmak hiçbir şey yapmamış
   gibi görünüyordu. Artık moloz, merminin girdiği yoldan geri çıkıyor.
2. **Sönme eğrisi tersti.** `(1-t)²` hemen karartıp sonra söner; bir kıvılcımın gerçekten yaşadığı dört
   karede bu, hiç parlak olmamış demektir. Artık `1-t²`.

**Ölüm animasyonu:** 0.55 saniyede devrilme, uzuvlar gevşiyor, 4.5 saniye yerde kalıyor sonra bırakılıyor.
Her ceset farklı yana devriliyor (`Math.random` değil, aktör kimliğinden türetilmiş, yani kare kare kararlı).

#### Bu ekran görüntüsüyle kanıtlanamadı

Sandbox ~2 FPS çiziyor, yani 0.55 saniyelik bir animasyon iki kare arasına düşüyor ve gövde yere
**ışınlanmış** gibi görünüyor. Bu yüzden rig'i 60 fps'te açık bir saatle süren **10 test** yazıldı: düşüş
monoton mu, ceset zamanında kalkıyor mu, diriliş pozu sıfırlıyor mu.

**Dürüst sınır:** izin *görünür* olduğunu ekran görüntüsüyle doğruladım. *İyi göründüğünü* değil.


### 10g. Ölüm ekranı, seyirci ve takım arkadaşını devralma

Ölünce hiçbir şey olmuyordu. `onPlayerDeath` input'u sıfırlıyor ve duruyordu: kamera olduğu yerde donuyor,
ekranda tek kelime yok, kimin öldürdüğünü öğrenmenin hiçbir yolu yok. Raundun kalanına kadar — ki bu bir
dakikaya kadar çıkabilir — hareketsiz bir duvara bakıyordun.

**Ölüm raporu.** Kim, hangi silahla, kaç metreden, kafa mı, katilin canı ne kadar. Bu bilgi `death` olayında
yoktu (o yalnızca öleni taşıyor); `registerDamage` içinde kaydediliyor, çünkü iki aktör de orada elde.

**Seyirci.** Ölür ölmez kamera canlı takım arkadaşına geçiyor — üçüncü şahıs, arkadan. **Q/E** ile takım
arkadaşları arasında geziniyorsun. Son arkadaşın da ölürse kamera serbest kalıyor (WASD ile uçarsın) — çünkü
yoksa yine donmuş bir kareye bakıyordun.

**Devralma (CS2'deki gibi).** İzlediğin takım arkadaşını **F** ile devralıyorsun: o artık sen oluyorsun,
normal şekilde oynuyorsun. Bıraktığın gövdeye yeni bir bot beyni veriliyor, böylece açıkta donup kalmıyor.

#### Bu neden "sadece bir kamera değişikliği" değil

Devralma, oyunda **oyuncunun kim olduğunu değiştiren tek özellik.** Bu yüzden değişmezler test ediliyor:

- Aynı anda **tek** aktör oyuncu olabilir. İki bayrak açık kalırsa skor tablosu iki ismi vurgular ve
  hangi gövdeyi kontrol ettiğin belirsizleşir.
- Sürdüğün aktörün **beyninin olmaması** gerekir. Beyin kalırsa bot seninle aynı gövde için kavga eder ve
  sen her strafe'de kontrolü kaybedersin.
- Bıraktığın gövde **geçerli bir raund üyesi olarak kalmalı** — kaybolmamalı, gölgen gibi peşinde
  koşmamalı.

#### Testlerin bulduğu gerçek hata

Ölüm raporu ekranda boş görünüyordu. Sebep: `deathInfo` alanları **`hudState` yerine `gameSnapshot`'a**
eklenmişti — yani hata ayıklama anlık görüntüsüne, HUD'un okuduğu yere değil. Saf yardımcı fonksiyonların
45 testi bunu yakalamadı, çünkü hepsi geçiyordu; değerler sadece HUD'a ulaşmıyordu. Ders: **saf mantık
testleri, kablolama hatalarını yakalamaz.** Bu yüzden bu turdan sonra `hudState`'in sözleşmesini doğrulayan
6 test eklendi.

#### Dürüst sınırlar

- **Killcam kaydediliyor ama oynatılmıyor.** Tampon dolu, örnekleme test edildi, ama kamera geçişi çalışmıyor
  — `updateSpectate` içindeki oynatma dalı yazıldı fakat sahne görüntüsüne bağlanmadı. Söylemem gereken
  şey: bu kısım yarım.
- **Devralınan botun nişan alması** kendi becerin, ama botun görüş açısı ve duruşu devraldığın yerden
  geliyor; bu bir hile değil, CS2'deki davranışın aynısı.

## 11. Lisans / varlıklar

- Tüm kod bu depo için yazıldı. Harita, modeller ve silahlar primitif mesh'lerden üretildi.
- Üretim bağımlılıkları: **three.js** (MIT) ve **lil-gui** (MIT) — ikisi de tek dosya build'e gömülü.
- Geliştirme bağımlılıkları: esbuild (MIT), jsdom (MIT), ESLint (MIT), **axe-core** (MPL-2.0; yalnızca
  geliştirme aracı olarak kullanılır, üretim dosyasına girmez).
- Ses tamamen prosedürel; hiçbir ses dosyası/örnek yok. Ticari oyun asset'i kullanılmadı.

---

## 12. Kapsam dışı bırakılanlar (bilinçli)

Şartname MVP dışını istemedi; aşağıdakiler **eklenmedi**: bomba kurma/çözme, satın alma/ekonomi,
çok oyunculu/online, hesap sistemi, ilerleme/kariyer kaydı, el bombası, revive, gamepad desteği,
spectator kamerası, skin/kozmetik, leaderboard. Mimari bunlara açık bırakıldı (`MatchManager` yeni
raund kuralları, `BotBrain` yeni durumlar, `WeaponData/config.js` yeni silahlar için ayrılmıştır).
