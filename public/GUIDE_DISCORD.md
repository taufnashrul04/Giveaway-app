# Discord OAuth Setup — GiveFuel

## 1. Buat Aplikasi Discord
1. Buka https://discord.com/developers/applications
2. Klik **New Application**
3. Nama: `GiveFuel` → Create
4. (Opsional) Isi ikon & description di tab General Information

## 2. Setup OAuth2 Redirect
1. Sidebar kiri → **OAuth2** → **General**
2. Scroll ke **Redirects** → klik **Add Redirect**
3. Masukkan URL redirect:
   - Untuk test lokal: `http://localhost:3000/auth/dc/callback`
   - Untuk production (Vercel): `https://<APP-URL>.vercel.app/auth/dc/callback`
   - (Bisa tambahkan DUA-DUANYA biar bisa test lokal + prod)
4. Klik **Save**

## 3. Ambil Client ID & Secret
1. Di halaman **OAuth2 → General** yang sama, atas halaman ada:
   - **Client ID** (angka panjang) → copy
   - **Client Secret** → klik **Reset/View** → copy
2. Simpan, nanti masuk ke env vars Vercel:
   - `DC_CLIENT_ID` = Client ID
   - `DC_CLIENT_SECRET` = Client Secret

## 4. (Opsional tapi disarankan) Avatar bot / app
- buat lucu², biar branding GiveFuel konsisten

## ⚠️ Yang PENTING
- **JANGAN** centang scope "bot" untuk OAuth — kita butuh scope **identify** + **guilds** (bukan bot).
  (Di halaman OAuth2 → Scopes, cukup centang `identify` dan `guilds`.)
- Scope `guilds` itu yang bikin bisa cek member di server Discord (fitur verify giveaway).
