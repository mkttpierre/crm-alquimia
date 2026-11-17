import type { MetadataRoute } from "next";

// Decisão de produto: nome "CRM" fixo.
//
// Os ícones são as imagens da marca (`app/icone-da-marca/[variante]/route.tsx`):
// o sol do produto sobre `#111111` quando nada está configurado, o ladrilho da cor
// da marca quando algo está — a mesma regra do ícone da aba e do apple-touch. Não
// são arquivos em `public/`: a imagem Docker é uma só para todas as marcas.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CRM",
    short_name: "CRM",
    display: "standalone",
    start_url: "/app",
    scope: "/",
    icons: [
      { src: "/icone-da-marca/app-192", sizes: "192x192", type: "image/png" },
      { src: "/icone-da-marca/app-512", sizes: "512x512", type: "image/png" },
    ],
  };
}
