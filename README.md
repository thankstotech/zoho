# Stock Matrix — Zoho Books Inventory Viewer

Live stock matrix for Zoho Books with multi-warehouse support, colour grouping, and team access control.

## Deploy to Vercel

### Step 1 — Get Zoho API credentials

1. Go to https://api-console.zoho.com
2. Click **Add Client → Self Client**
3. Note your **Client ID** and **Client Secret**
4. Under **Generate Code**, enter scope:
   ```
   ZohoBooks.inventory.READ,ZohoBooks.settings.READ
   ```
5. Set duration to **10 minutes**, click Generate
6. Copy the **code** shown

Now exchange the code for a refresh token. Run this in your terminal (replace values):

```
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "code=YOUR_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://www.zoho.com/books" \
  -d "grant_type=authorization_code"
```

Copy the **refresh_token** from the response.

7. Your **Organization ID**: In Zoho Books → Settings → Organization Profile → Organization ID

### Step 2 — Deploy to Vercel

1. Create a GitHub account if you don't have one: https://github.com
2. Create a new repository, upload all files keeping this folder structure:
   ```
   zoho-stock/
   ├── public/index.html
   ├── api/stock.js
   ├── api/settings.js
   ├── vercel.json
   └── .env.example
   ```
3. Go to https://vercel.com → Sign up (free) → New Project
4. Import your GitHub repository
5. Click **Environment Variables** and add:
   | Key | Value |
   | --- | --- |
   | `ZOHO_CLIENT_ID` | from Step 1 |
   | `ZOHO_CLIENT_SECRET` | from Step 1 |
   | `ZOHO_REFRESH_TOKEN` | from Step 1 |
   | `ZOHO_ORG_ID` | from Step 1 |
   | `APP_SECRET` | any long random string (e.g. `xK9mP2qR8nL5wJ3vT7yH4cB6`) |
6. Click **Add Vercel KV** (free tier) from the Storage tab — this stores your settings and users
7. Click **Deploy**

Your app is now live at `https://your-project.vercel.app`

### Step 3 — First login

- **Username:** `admin`
- **Password:** `Matrix`

Go to **Settings** to:
- Add team users with warehouse restrictions
- Reorder categories
- Assign keywords to categories
