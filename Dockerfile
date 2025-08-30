# Use an official Node.js runtime as a parent image
# Using the Long-Term Support (LTS) version is a good practice
FROM node:22-slim

# Install Python and yt-dlp
# We switch to root to perform these operations and then switch back to the node user.
USER root
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    pip3 install "yt-dlp[default,curl-cffi]" --break-system-packages && \
    rm -rf /var/lib/apt/lists/*
USER node

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
# This leverages Docker's layer caching. These files don't change often,
# so this step will be cached, speeding up future builds.
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
# Copy the rest of your app's source code from your host to your image filesystem.
COPY . .

# Your app binds to port 7000, so you need to expose it
# The README.md's app_port should match this.
EXPOSE 7000

# Define the command to run your app
# This uses the "start" script from your package.json
CMD ["bash", "./start.sh"]
