# YouTubio: Stremio YouTube Addon

This is a Stremio addon that allows you to watch YouTube videos, and access your subscriptions, watch later list, and history directly in Stremio.

-----

## Features

  * **Watch YouTube Content in Stremio**: Browse and watch your favorite YouTube videos without leaving the Stremio application.
  * **Personalized Feeds**: Access your YouTube subscriptions, "Watch Later" list, and viewing history.
  * **Powerful Search**: Search for YouTube videos and channels directly within Stremio.
  * **Customizable Catalogs**: The addon provides default catalogs and allows you to add your own custom playlists.
  * **Secure Configuration**: User configuration, including cookies, is encrypted for security.
  * **Easy Deployment**: Deploy the addon using Docker.

-----

## How to Use

1.  **Configuration**: Access the addon's configuration page by navigating to the root URL where the addon is hosted.
2.  **Cookies**: To get personalized content, you'll need to add your YouTube cookies. The configuration page provides instructions on how to export your cookies.
3.  **Playlists**: You can add default playlists like "Discover," "Subscriptions," "Watch Later," and "History," or add your own custom playlists.
4.  **Generate Install Link**: Once you have configured the addon, you can generate an installation link for Stremio.

-----

## Deployment

You can deploy this addon using Docker.

### Prerequisites

  * Docker installed on your system.

### Steps

1.  **Build the Docker image**:
    ```bash
    docker build -t youtubio .
    ```
2.  **Run the Docker container**:
    ```bash
    docker run -p 7000:7000 youtubio
    ```
    The addon will be running on port 7000.

-----

## Technical Details

### Main Dependencies

  * **Node.js**: The runtime environment for the addon.
  * **Express**: A web framework for Node.js used to create the addon's server.
  * **yt-dlp-wrap**: A Node.js wrapper for `yt-dlp`.
  * **yt-dlp**: A command-line program to download videos from YouTube and other sites.

### File Structure

  * `addon.js`: The main application file containing the server-side logic for the Stremio addon.
  * `Dockerfile`: Contains the instructions to build the Docker image for the application.
  * `package.json`: Defines the project's metadata and dependencies.
  * `.github/workflows/release-please.yaml`: A GitHub Actions workflow for automating releases.
  * `.gitignore`: Specifies files and folders to be ignored by Git.

### Automated Releases

This project uses `release-please-action` to automate the release process. When changes are pushed to the `main` branch, this action will create a pull request with the next version number and a changelog. Merging this pull request will create a new release on GitHub.
