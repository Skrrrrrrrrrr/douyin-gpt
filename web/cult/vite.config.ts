import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {viteSingleFile} from 'vite-plugin-singlefile';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react(),tailwindcss(),viteSingleFile()],resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},build:{outDir:'dist',emptyOutDir:true,cssCodeSplit:false,reportCompressedSize:true},server:{proxy:{'/api':'http://127.0.0.1:3146','/host':'http://127.0.0.1:3146','/fonts':'http://127.0.0.1:3146'}}});
