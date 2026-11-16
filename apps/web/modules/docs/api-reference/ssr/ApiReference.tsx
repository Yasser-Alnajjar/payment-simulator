import { ApiReferenceViewer } from "../csr/ApiReferenceViewer";

/** The reference is static and public: no data to fetch, no user to resolve. The spec is generated at build time (public/openapi.json). */
export const OPENAPI_URL = "/openapi.json";

export const ApiReference = async () => <ApiReferenceViewer specUrl={OPENAPI_URL} />;
