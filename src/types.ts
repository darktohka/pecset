/**
 * Shared, serializable domain types.
 *
 * This file is the single source of truth for the contract between the PDF
 * signing engine (`src/lib/**`) and the React UI (`src/components/**`).
 * Nothing in here may depend on a concrete library at runtime.
 */

/* -------------------------------------------------------------------------- */
/*                                  Errors                                     */
/* -------------------------------------------------------------------------- */

export type P12ErrorCode =
  | 'password-required'
  | 'wrong-password'
  | 'invalid-format'
  | 'no-private-key'
  | 'unknown';

/** Error thrown while parsing / unlocking a `.p12` / `.pfx` file. */
export class P12Error extends Error {
  readonly code: P12ErrorCode;
  constructor(code: P12ErrorCode, message: string) {
    super(message);
    this.name = 'P12Error';
    this.code = code;
  }
}

export type SignErrorCode =
  | 'no-certificate'
  | 'no-signer'
  | 'no-placement'
  | 'invisible-dummy'
  | 'certificate-locked'
  | 'certification-locked'
  | 'encrypted-pdf'
  | 'cms-too-large'
  | 'byte-range-not-found'
  | 'invalid-pdf'
  | 'invalid-date'
  | 'timestamp-failed'
  | 'unknown';

/** Error thrown while producing the signed document. */
export class SignError extends Error {
  readonly code: SignErrorCode;
  constructor(code: SignErrorCode, message: string) {
    super(message);
    this.name = 'SignError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Certificates                                  */
/* -------------------------------------------------------------------------- */

/** Human readable identity + validity data extracted from a certificate. */
export interface SignerInfo {
  commonName: string;
  email: string | null;
  organization: string | null;
  organizationalUnit: string | null;
  /** Fully assembled distinguished name, e.g. `CN=A,O=B,C=RO`. */
  distinguishedName: string;
  country: string | null;
  locality: string | null;
  state: string | null;
  issuerCommonName: string | null;
  /** Uppercase hex, no separators. */
  serialNumber: string;
  /** ISO-8601 timestamps. */
  notBefore: string;
  notAfter: string;
  /** Colon separated uppercase hex, e.g. `AA:BB:...`. */
  fingerprintSha256: string;
  keyAlgorithm: string;
  keySize: number;
  isExpired: boolean;
  /** Days until expiry (negative when already expired). */
  daysUntilExpiry: number;
}

/**
 * A certificate persisted in IndexedDB.
 *
 * `p12Bytes` is stored as a `Uint8Array` (structured-clone friendly). The
 * password is only present when the user explicitly asked to remember it.
 */
export interface StoredCertificate {
  id: string;
  /** User editable display name; defaults to the file name. */
  label: string;
  fileName: string;
  p12Bytes: Uint8Array;
  passwordStored: boolean;
  password?: string;
  /**
   * Name drawn in the Adobe-style appearance and recorded in the signature
   * dictionary `/Name`, when the user wants something other than the
   * certificate's own common name. The certificate subject signed by the CMS is
   * never affected. Absent (or blank) means "use the common name".
   */
  nameOverride?: string;
  info: SignerInfo;
  addedAt: string;
  lastUsedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                   Signers                                   */
/* -------------------------------------------------------------------------- */

/**
 * `certificate` is backed by a `.p12`/`.pfx` and produces a real signature;
 * `dummy` is a saved, purely visual identity that produces no signature.
 */
export type SignerType = 'certificate' | 'dummy';

/** `id` names a `StoredCertificate.id` for `certificate`, a `DummySigner.id` for `dummy`. */
export interface SignerRef {
  type: SignerType;
  id: string;
}

/** A custom PNG/JPEG signature image saved for reuse from the gallery. */
export interface SavedSignatureImage {
  id: string;
  name: string;
  /** Empty string means no description. */
  description: string;
  /** `data:image/png|jpeg;base64,…` - the form the appearance builder and previews consume. */
  imageDataUrl: string;
  width: number;
  height: number;
  /** Ascending sort key, kept contiguous (0..n-1) by every reorder. */
  order: number;
  addedAt: string;
}

/** A saved fake signer with no key material behind it. */
export interface DummySigner {
  id: string;
  name: string;
  /** Empty string means no description. */
  description: string;
  addedAt: string;
}

/* -------------------------------------------------------------------------- */
/*                                   PDF                                       */
/* -------------------------------------------------------------------------- */

export interface PdfPageInfo {
  index: number;
  /** CropBox size in PDF points. */
  width: number;
  height: number;
  /** Page rotation in degrees as declared in the page dictionary (0/90/180/270). */
  rotation: number;
}

export interface PdfSignatureFieldInfo {
  name: string;
  /** `true` when a `/V` signature dictionary is present. */
  signed: boolean;
}

/** DocMDP certification carried by the document. */
export interface PdfCertificationInfo {
  /** Permission level: 1 = no changes, 2 = form fill + signing, 3 = annotations too. */
  permission: number;
  /** Signature field carrying the certification, when it could be resolved. */
  fieldName: string | null;
}

export interface PdfInspection {
  pageCount: number;
  pages: PdfPageInfo[];
  signatureFields: PdfSignatureFieldInfo[];
  hasSignatures: boolean;
  /** Number of distinct `/Sig` dictionaries encountered. */
  signatureCount: number;
  /** `null` unless the document carries a DocMDP certification signature. */
  certification: PdfCertificationInfo | null;
}

/* -------------------------------------------------------------------------- */
/*                                 Signatures                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a signature is rendered on the page.
 * - `invisible`     - cryptographic signature only, no visible appearance.
 * - `adobe`         - Adobe Acrobat style appearance (name + date, check mark).
 * - `image`         - user supplied image (PNG/JPEG) as the appearance.
 */
export type SignatureKind = 'invisible' | 'adobe' | 'image';

/**
 * Whether the produced revision should remain open to further signatures
 * (`continue`) or be locked as a final/certification signature (`finalize`).
 */
export type ChainMode = 'continue' | 'finalize';

/**
 * A signature box placed on a page.
 *
 * Geometry is expressed in PDF user space, in points, with the origin at the
 * bottom-left of the (unrotated) page. `cx`/`cy` is the *centre* of the box so
 * that rotation keeps the box in place.
 */
export interface SignaturePlacement {
  id: string;
  kind: SignatureKind;
  /** 0-based page index. */
  pageIndex: number;
  cx: number;
  cy: number;
  /** Unrotated box size in points. */
  width: number;
  height: number;
  /** Clockwise rotation in degrees, as displayed to the user. */
  rotation: number;
  /** Data URL of the uploaded image; only for `kind === 'image'`. */
  imageDataUrl?: string;
  /**
   * Signer this placement was added under. When omitted the placement inherits
   * the signer that is selected at signing time, which keeps "place now, pick a
   * signer later" working.
   */
  signer?: SignerRef;
  /** Gallery entry this placement came from; display only. */
  savedImageId?: string;
}

/** Optional RFC 3161 timestamp authority for real signatures. */
export interface TimestampSettings {
  /** Absolute TSA endpoint; must send CORS headers to be usable from the browser. */
  url: string;
  /** Request timeout in milliseconds; defaults to 15000. */
  timeoutMs?: number;
}

/** Source of the signing time when no timestamp authority is used. */
export type SigningTimeMode = 'now' | 'custom';

/** Treatment of the document Info/XMP dates when a custom signing time is used. */
export type PdfDateMode = 'unmodified' | 'signature' | 'custom';

export interface SignOptions {
  reason?: string;
  location?: string;
  contactInfo?: string;
  chainMode: ChainMode;
  /** When set, timestamp every real signature via this authority. */
  timestamp?: TimestampSettings | null;
  /** Ignored while `timestamp` is set: the authority provides the trusted time. */
  signingTimeMode?: SigningTimeMode;
  /** Local ISO-8601 datetime (`YYYY-MM-DDTHH:mm`) for `signingTimeMode: 'custom'`. */
  signingTime?: string | null;
  /** Document date treatment; only consulted for a custom signing time with no timestamp. */
  pdfDates?: PdfDateMode;
  /** Local ISO-8601 datetime for `pdfDates: 'custom'`. */
  pdfCustomDate?: string | null;
}

/** Result of a successful signing operation. */
export interface SignResult {
  pdfBytes: Uint8Array;
  /** Size of the produced file in bytes. */
  byteLength: number;
  /** Size of the appended incremental revision in bytes. */
  incrementalByteLength: number;
  signatureFieldNames: string[];
  /** Placements written as visible-only dummy marks, so they carry no `/Sig` dictionary. */
  dummyNames: string[];
  /** `true` when the signature was applied as a certification (locking) signature. */
  certified: boolean;
  /** `true` when an RFC 3161 timestamp token was embedded in the signatures. */
  timestamped: boolean;
  /** Endpoint of the authority used, when `timestamped`. */
  timestampAuthority: string | null;
  /** Effective signing date (ISO-8601) written to the document. */
  signingTime: string;
  /** `true` when the PDF Info/XMP dates were changed. */
  documentDatesChanged: boolean;
  /** Non-fatal problems encountered while signing. */
  warnings: string[];
}
