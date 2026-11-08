# QA RAPORU — SIFIR NOKTA

Üretim: `node tools/qa.mjs` · 2026-11-08 16:41 UTC

| Geçti | Uyarı | Hata |
|---|---|---|
| 35 | 0 | 0 |

> Bu rapor otomatik üretilir. Core senaryoları renderer olmadan maç mantığını,
> uygulama senaryoları ise gerçek `src/main.js` kabuğunu jsdom içinde sürer.


## maç/easy

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | tamamlanma | 4/4 maç bitti · skorlar 2-3, 0-3, 0-3, 1-3 |
| ✅ PASS | raund süresi | ort 40.8 s · en uzun 80.0 s |
| ✅ PASS | tıkanma oranı | 1/15 raund süre limitiyle karara bağlandı |

## maç/normal

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | tamamlanma | 4/4 maç bitti · skorlar 1-3, 1-3, 0-3, 0-3 |
| ✅ PASS | raund süresi | ort 35.9 s · en uzun 80.0 s |
| ✅ PASS | tıkanma oranı | 2/14 raund süre limitiyle karara bağlandı |

## maç/hard

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | tamamlanma | 4/4 maç bitti · skorlar 0-3, 0-3, 1-3, 1-3 |
| ✅ PASS | raund süresi | ort 26.0 s · en uzun 67.5 s |
| ✅ PASS | tıkanma oranı | 0/14 raund süre limitiyle karara bağlandı |

## zorluk

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | bot isabet oranı | kolay 24% (173/711) · normal 21% (133/631) · zor 26% (125/474) |
| ✅ PASS | ayrışma | zor/kolay isabet farkı 8% |
| ✅ PASS | hata payı | zor botlar da kaçırıyor (LOS ve nişan hatası korunuyor) |
| ✅ PASS | canlı geçiş | tüm botlar yeni profile geçti |
| ✅ PASS | hasar sabitliği | maks can 100/100 (zorluk hasarı değiştirmiyor) |

## raund

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | canlı oyuncu sayısı | 10/10 (yeniden doğma yok) |
| ✅ PASS | yeniden doğma | canlı 10 → 10, ölüm 0 → 0 |
| ✅ PASS | çift ölüm | oyuncu başına en fazla 1 ölüm/raund |

## duraklatma

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | donma | 3 s boyunca hiçbir aktör hareket etmedi / hasar almadı |
| ✅ PASS | devam | sayaç devam etti |
| ✅ PASS | Esc | oyun durakladı |
| ✅ PASS | HUD sabit | duraklamada HUD değişmedi |

## akış

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | ana menü | açılışta menü görünür |
| ✅ PASS | ayarlar | menüden açılıyor |
| ✅ PASS | ayarlar dönüş | menüye dönüldü |
| ✅ PASS | kontroller | liste görünür |
| ✅ PASS | zorluk ekranı | görünür |
| ✅ PASS | maç başlangıcı | HUD açıldı, oyun nesnesi var |

## maç

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | geri sayım kilidi | geri sayımda ateş/hasar yok |
| ✅ PASS | ateş | 24 atış yapıldı |
| ✅ PASS | hareket | oyuncu spawn'dan 19.2 m uzaklaştı |
| ✅ PASS | maç sonu | skor 3-0 |

## HUD

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | can göstergesi | 100 = 100 |
| ✅ PASS | zırh göstergesi | 50 |

## konsol

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | çalışma zamanı hatası | yok |

## bellek

| Durum | Senaryo | Ölçüm |
|---|---|---|
| ✅ PASS | renderer örneği | 1 WebGLRenderer oluşturuldu (1 beklenir) |
