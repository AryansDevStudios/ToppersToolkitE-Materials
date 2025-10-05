git init


chmod +x start.sh
cd /opt/render/project/src
chmod +x filebrowser
chmod +x start.js
/opt/render/project/src/filebrowser -a 0.0.0.0 -p 8080
npm install express shelljs dotenv