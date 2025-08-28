# 📺 YouTubio: Stremio YouTube Addon

A **Stremio addon** that lets you watch YouTube videos and access your **subscriptions**, **Watch Later list**, and **history** directly inside Stremio.

---

## ✨ Features
- **Watch YouTube Content in Stremio** – Browse and watch your favorite YouTube videos without leaving the Stremio app.  
- **Personalized Feeds** – Access your Subscriptions, *Watch Later* list, and viewing history.  
- **Powerful Search** – Search for YouTube videos and channels directly within Stremio.  
- **Customizable Catalogs** – Use default catalogs or add your own custom playlists.  
- **Secure Configuration** – User data (including cookies) is **encrypted** for security.  
- **Easy Deployment** – Deploy with **Docker** or **Node.js**.  

---

## Quick Setup with Cookies
For more detailed instructions or other platforms, go to the [YT-DLP cookie extraction guide](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)
### Install the addon [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) (or [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/) for Firefox)
<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/b60986e1-7484-412d-84af-f4d90973ab83" />
<img width="506" height="282" alt="image" src="https://github.com/user-attachments/assets/10c73fba-e850-4a41-a25a-46afd6a71fea" /><br>

### Go to [youtube.com](https://www.youtube.com) and sign in if you want personalized content<br>
<img width="378" height="206" alt="image" src="https://github.com/user-attachments/assets/d70f0d12-e10d-46bd-b682-4d5e67d4aa72" /><br>
<img width="558" height="432" alt="image" src="https://github.com/user-attachments/assets/82caac82-0acd-469a-8bae-36ca2207cd83" /><br>
<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/0157804a-6732-4ae5-b85d-c4235c04ab95" /><br>
<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/fb0a738a-9447-4de5-af34-18a3bb5bada1" /><br>
<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/e2857a18-06cc-481a-8564-bcc9de5c353f" /><br>

---

## 🛠 How to Use
1. **Configuration** – Open the addon's config page at the root URL where it’s hosted.  
2. **Cookies** – Add your YouTube cookies for personalized content (instructions are provided on the config page).  
3. **Playlists** – Add default playlists like *Discover*, *Subscriptions*, *Watch Later*, and *History*, or set up custom ones.  
4. **Install Link** – Generate a Stremio installation link after configuring.  

---

## 🚀 Deployment

You can deploy using **Docker** or **Node.js**.

---

### 🐳 Docker Deployment

#### ✅ Prerequisites
- **Docker** installed on your system  

#### ⚡ Steps
```bash
# Build the Docker image
docker build -t youtubio .
```

### 🟢 Node.js Deployment

#### ✅ Prerequisites
- **Node.js** installed (v16+ recommended)
- **npm** package manager

#### ⚡ Steps
```bash
# Install dependencies
npm install

# Start the addon
node addon.js
```

By default, the addon will be available at: `http://localhost:7000`
