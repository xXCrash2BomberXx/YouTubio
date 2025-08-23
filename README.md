# 📺 YouTubio: Stremio YouTube Addon

A **Stremio addon** that lets you watch YouTube videos and access your **subscriptions**, **Watch Later list**, and **history** directly inside Stremio.

---

## ✨ Features
- **Watch YouTube Content in Stremio** – Browse and watch your favorite YouTube videos without leaving the Stremio app.  
- **Personalized Feeds** – Access your Subscriptions, *Watch Later* list, and viewing history.  
- **Powerful Search** – Search for YouTube videos and channels directly within Stremio.  
- **Customizable Catalogs** – Use default catalogs or add your own custom playlists.  
- **Secure Configuration** – User data (including cookies) is **encrypted** for security.  
- **Easy Deployment** – Quickly deploy the addon using Docker.  

---

## 🛠 How to Use
1. **Configuration** – Open the addon's config page at the root URL where it’s hosted.  
2. **Cookies** – Add your YouTube cookies for personalized content (instructions are provided on the config page).  
3. **Playlists** – Add default playlists like *Discover*, *Subscriptions*, *Watch Later*, and *History*, or set up custom ones.  
4. **Install Link** – Generate a Stremio installation link after configuring.  

---

## 🚀 Deployment

You can deploy using **Docker**.

### ✅ Prerequisites
- **Docker** installed on your system.  

### ⚡ Steps
```bash
# Build the Docker image
docker build -t youtubio .

# Run the container
docker run -p 7000:7000 youtubio
