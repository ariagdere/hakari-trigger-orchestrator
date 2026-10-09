// Naif (hizli yol) webhook'unun gonderildigi zaman penceresi -- Istanbul saatiyle
// (UTC+3, 2016'dan beri DST yok -- sabit kayma yeterli):
//   Pazartesi 00:00 -> Cuma 15:00 arasinda BASLAYAN dongulerin sinyali gonderilir;
//   Cuma 15:00'ten sonra baslayanlar ve hafta sonu gonderilmez.
//
// Karar dongunun basladigi ana (/start) gore verilir, Apify sonucunun geldigi ana gore degil:
// sonuc birkac dakika (yeniden denemelerde daha fazla) sonra gelir -- 15:00 dongusunun sonucu
// 15:10'da gelse de gonderilir. Tetikleyicinin (Make) birkac dakikalik gecikmesi icin Cuma 15:00'e
// FRIDAY_GRACE_MIN dakika tolerans var.
//
// Sunucu (Railway) UTC calisir; UTC gece yarisina yakin saatlerde dogrudan getDay() yanlis gunu
// verebilir -- bu yuzden once +3 saat kaydirip UTC gun / saatini okuyoruz.

export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000
export const FRIDAY_CUTOFF_MIN = 15 * 60 // Cuma 15:00
export const FRIDAY_GRACE_MIN = 5

export function isNaifWindowIstanbul(ms: number): boolean {
  const ist = new Date(ms + ISTANBUL_OFFSET_MS)
  const day = ist.getUTCDay() // 0=Pazar ... 6=Cumartesi
  if (day === 0 || day === 6) return false
  if (day === 5) {
    const minuteOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes()
    return minuteOfDay < FRIDAY_CUTOFF_MIN + FRIDAY_GRACE_MIN
  }
  return true
}
