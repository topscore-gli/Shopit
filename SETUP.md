# ShopNG — Marketplace setup (about 20 minutes)

## 1. Create the Firebase project
1. https://console.firebase.google.com → **Add project**.
2. **Build → Authentication → Get started** → enable **Email/Password** and **Google**.
3. **Build → Firestore Database → Create database** (production mode).
4. **Build → Storage → Get started** (for product photos).
5. Upgrade to the **Blaze (pay-as-you-go)** plan — required for Cloud Functions + Storage. The free allowance is generous; a small store typically costs ₦0.
6. **Project settings → General → Your apps → Web app (</>)** → copy the config into `firebase-config.js`.
7. **Authentication → Settings → Authorized domains** → add your site domain (e.g. `coachflux.github.io`).

## 2. Make yourself admin
Open `firestore.rules` and `storage.rules` and replace `YOUR_ADMIN_EMAIL@gmail.com` with **your email**.
Also put it in `firebase-config.js` (`adminEmail`). Admin access = that email, **verified**. Sign in with Google (auto-verified) or verify the email link Firebase sends you.

## 3. Paystack
1. https://dashboard.paystack.com → Settings → **API Keys & Webhooks**.
2. Put the **Public key** (`pk_test_…` / `pk_live_…`) in `firebase-config.js`.
3. The **Secret key** never goes in the website. Store it in Firebase:
   ```
   npm i -g firebase-tools
   firebase login
   firebase use YOUR_PROJECT_ID
   firebase functions:secrets:set PAYSTACK_SECRET     # paste sk_test_… / sk_live_…
   ```
4. Deploy backend + rules:
   ```
   cd functions && npm install && cd ..
   firebase deploy --only functions,firestore:rules,storage
   ```
5. In Paystack → Webhook URL set: `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/paystackWebhook`

## 4. Publish the site
Upload every file in this folder (except `functions/`, rules and `.md` if you like) to GitHub Pages / any static host.

## 5. Open the admin dashboard
Go to `https://YOUR-SITE/admin.html`, sign in with your admin account, then:
**Products → "Import sample data"** (optional demo catalogue), or **Add product** to upload your own with photos, per category.
Admin is **not linked anywhere in the shop**; it only works for your verified admin email, enforced by Firestore rules.

## How security works
- Prices, stock, delivery fee and totals are computed **on the server** from Firestore — the browser cannot change what it pays.
- Payments are verified with Paystack's API (secret key, server-side) and by signed webhook; the paid amount must equal the order total.
- Customers can only read their own orders and edit their own profile. Only the admin can edit products/categories and update order status.
- Product text is HTML-escaped before display; a Content-Security-Policy limits which scripts/frames can load.
- Test with Paystack **test keys** + test card `4084 0840 8408 4081` before going live.
