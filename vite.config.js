import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS is required on phones: WebXR and the gyro (DeviceOrientation) only work in a secure context.
// basicSsl makes a self-signed cert; the phone will warn once, tap through it.
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true, // listen on your LAN IP so the phone can reach it
    port: 5173,
    // lets a Cloudflare quick tunnel reach the dev server (see README)
    allowedHosts: [".trycloudflare.com"],
  },
  preview: { host: true, port: 4173 },
});
