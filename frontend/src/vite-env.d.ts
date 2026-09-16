/// <reference types="vite/client" />

declare const __ITLES_FRONTEND_BUILD_ID__: string;

declare module "*.geojson" {
  const data: import("geojson").GeoJsonObject;
  export default data;
}
