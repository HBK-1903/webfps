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
(`%TEMP%\sifirnokta-profile`). Bu, dağıtılabilir bir `.exe` değil, bir masaüstü pencere sarmalayıcısıdır.

### Testler ve kalite kapısı
```bash
npm test             # 89 test, tamamı headless (Node + jsdom)
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
| `F3` | Hata ayıklama katmanı (bot durumları, şeritler, konumlar, zamanlar) |
| Pencere odağı kaybı | Otomatik duraklatma (input ve botlar durur) |

Ayarlar: fare hassasiyeti, ses düzeyi, görüş açısı (FOV), grafik kalite, silah sarsıntısı açık/kapalı.
Hepsi `localStorage`'da saklanır ve yeniden açılışta korunur.

---

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
- Reload / silah değiştirme / ölüm / raund sonu kuralları tutarlı: reload iptali, boş şarjörde otomatik reload,
  ölümde ve raund sonunda kontroller susar.
- Vuruş geri bildirimi: hitmarker (öldürmede kırmızı), kafa isabeti sesi farklı, kan/gore yok.

**Bot AI** (`src/core/bot.js`)
- Görüş: FOV konisi + mesafe + **gerçek LOS raycast** — duvar arkası görülmez, zorluk LOS'u atlatmaz.
- Son görülen konumu araştırma; ses ipuçları **yaklaşık** konum verir (tam koordinat sızdırmaz).
- A* ızgara navigasyonu, 3 şerit (orta/kuzey/güney), takım arkadaşları arasında şerit dağıtımı,
  paylaşılan arama bölgesi (yığılma yerine yayılma), takım süpürmesi, sıkışma tespiti + yeniden yol bulma.
- Gövde çakışması çözülür (tek yönlü itme): botlar birbirinin içine girmez, kapılardan sırayla geçer.
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
- HUD: can, zırh, silah, şarjör/yedek, kendi takım listesi, canlı sayıları, skor, raund durumu,
  geri sayım, nişangâh (yayılmaya göre açılan), hitmarker, reload halkası, killfeed, hasar yönü.
- Menü → zorluk → ayarlar → kontroller → duraklatma → maç sonu akışının tamamı.
- Ses tamamen prosedürel (WebAudio): silah sesleri, mesafeye göre kısılma, isabet, reload, raund/maç stinger'ları.
  Hiç ses dosyası yok.

---

## 4. Mimari

```
src/
  core/                 # Oyun mantığı — DOM/WebGL bilmez, saf ve test edilebilir
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
tests/                  # 89 test (core, AI, HUD, e2e app boot)
tools/serve.mjs         # dev sunucusu
tools/sim.mjs           # headless maç simülatörü
build.mjs               # tek dosya offline build
```

Tasarım kararı: **tüm oynanış `src/core`'da**, renderer sadece okur. Bu sayede maç akışı, hasar,
bot davranışı ve zorluk farkı tarayıcı olmadan da ölçülebiliyor (`npm test`, `npm run sim`).

---

## 5. Test raporu

`npm test` → **89/89 geçti** (Node 22 + jsdom, headless):

| Dosya | Kapsam |
|---|---|
| `tests/damage.test.js` (9) | Zırh absorbsiyonu (%50, bağışıklık değil), zırh tükenmesi, kafa çarpanı, ölüm sayımı, menzil düşüşü, dost ateşi kapalı, silah verisi özgünlüğü |
| `tests/weapons.test.js` (12) | Ateş hızı, tek/otomatik tetik, boş şarjör, reload transferi/iptali, ateş kilidi, geri tepme birikmesi/toparlanması, yayılma |
| `tests/match.test.js` (11) | 5v5 kurulum, geri sayım, eleme ile raund sonu, çift tetiklenmeme, raund reseti (can/zırh/ammo/pozisyon), ilk-3 zafer, beraberlik, tıkanma kararı, maç sonu dondurma |
| `tests/nav.test.js` (11) | Yürünebilirlik, spawn simetrisi ve güvenliği, A* erişilebilirliği, tünelleme yok, LOS, ray-cast |
| `tests/ai.test.js` (16) | Duvar arkasını görmeme, FOV konisi, zorluk farkı (ölçülmüş tepki/isabet), son bilinen konum, işitme gürültüsü, boş şarjörle ateş etmeme, harita dışına çıkmama, yığılmama, lane yürüyüşü (spawn'da kilitlenmeme), sessiz raundun çözülmesi (tıkanma bütçesi), tohumlu maç tekrarlanabilirliği (determinizm), takım arkadaşıyla ayrışma |
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

**`npm run matrix`** (denge matrisi, **60 maç/hücre** → `docs/qa-matrix.json`):
oyuncunun takımının kazanma oranı — kolayda otomatik oyuncuyla %75, normalde %62, zorda %47; hareketsiz
(idle) oyuncuyla kolayda %23, normalde %8, zorda %8. Zorluk kademeleri arasında gerçek bir fark var ve
sıra tutarlı: hareketsiz oyuncu her kademede kaybediyor, zor botlar otomatik oyuncuyu bile %50'nin altına
çekiyor. Ortalama raund süreleri kolay 28–29 s, normal 17–25 s, zor 14–18 s; **tıkanan raund oranı %0–3**
(hedef <%25).

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
- Görsel/piksel doğrulama bu ortamda yapılamadı (WebGL yok). Sahne, kamera yönleri ve HUD mantığı
  testlerle doğrulandı; **görsel his** sizin tarafınızda kontrol edilmeli.
- Bot AI, şartnamedeki davranış listesinin stabil bir alt kümesidir. **Yok:** explicit cover-noktaları
  (sipere bilinçli yerleşme), takım arkadaşını canlı destekleme/revive, el bombası, sesle yön tayini
  yapan gelişmiş işitme modeli. `BotBrain` yeni durumlar eklemeye uygun ayrılmıştır.
- Botlar birbirine taktiksel olarak "siper ol" diyemez; koordinasyon paylaşılan temas + arama bölgesi düzeyinde.
- Görsel kalite "yüksek" ayarında gölge açılır; entegre GPU'larda FPS düşebilir (kalite ayarı düşürülebilir).
- Ses sentetik olduğu için gerçek silah kayıtları kadar zengin değil.
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
| `npm test` | 89 headless test |
| `npm run lint` | ESLint (hata odaklı) |
| `npm run a11y` | Erişilebilirlik denetimi (axe-core, WCAG 2.1 A/AA) — şu an **6 ekran / 0 ihlal** |
| `npm run verify` | lint + test + a11y + build |
| `npm run build` | Tek dosya offline build (`dist/SifirNokta.html`) |
| `npm run qa` | Senaryolu playtest + `docs/QA-REPORT.md` (JSON: `node tools/qa.mjs --json`) |
| `npm run matrix` | Denge matrisi: zorluk × oyuncu modu, kazanma/tıkanma oranları (`docs/qa-matrix.json`). Güncel tablo: 60 maç/hücre, 360 maç |
| `npm run sim -- <zorluk> <seed> <maç>` | Headless maç simülatörü |

İncelenip değerlendirilen GitHub kaynakları (ve bilinçli olarak alınmayanlar): [`docs/KAYNAKLAR.md`](docs/KAYNAKLAR.md).

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
