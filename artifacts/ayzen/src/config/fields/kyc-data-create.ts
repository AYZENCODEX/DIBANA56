import type { FieldDef } from "@/config/types";

// Field config for the KYC "Data Entity" create/edit dialog — split out of
// kyc-create.ts's old "KYC · Info" sub-tab. A Data Entity holds ONLY the
// identity/KYC-document fields — no account credentials (no password, no
// email, no 2FA). Those stay on the KYC Entity, which links to a Data
// Entity instead of duplicating this data. See components/vault/
// data-entity-picker.tsx (the picker used inside the KYC create dialog)
// and routes/kyc-data-entities.ts on the backend.

export const KYC_DATA_FIELDS: FieldDef[] = [
  {
    key: "nidNumber", label: "NID Number", type: "text",
    pairKey: "info-1", placeholder: "e.g. 1990123456789", compact: true,
  },
  {
    key: "name", label: "Name", type: "text",
    pairKey: "info-1", placeholder: "Full name as on NID", compact: true,
  },
  {
    key: "fatherName", label: "Father's Name", type: "text",
    pairKey: "info-2", placeholder: "Father's full name", compact: true,
  },
  {
    key: "birthDate", label: "Birthdate", type: "date",
    pairKey: "info-2", compact: true,
  },
  {
    key: "photo1Url", label: "Photo 1", type: "image",
    help: "NID front (or any ID photo).",
  },
  {
    key: "photo2Url", label: "Photo 2", type: "image",
    help: "NID back (or a second ID photo).",
  },
  {
    key: "notes", label: "Notes", type: "textarea",
    placeholder: "Any additional info about this data entity...", rows: 3,
  },
];
