/**
 * Shared export error types, kept in a standalone module so that lightweight
 * consumers (e.g. kfnExport, the export dialog) can import them without pulling
 * in the full MP4 export pipeline (which depends on mediabunny / WebCodecs).
 */
export class ExportError extends Error {}

export class ExportCanceledError extends Error {}
