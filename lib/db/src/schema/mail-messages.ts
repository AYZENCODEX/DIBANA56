import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Cache of IMAP-synced mail for the "Email Manager" plugin's third-party
// accounts (email_accounts table). Was referenced everywhere via raw SQL
// but had no schema/migration — see migrations/037_mail_messages_table.sql.
export const mailMessagesTable = pgTable("mail_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  emailAccountId: integer("email_account_id").notNull(),
  sourceCategory: text("source_category").notNull().default("other"),
  sourceId: text("source_id"),
  uid: integer("uid").notNull(),
  seqno: integer("seqno"),
  fromAddr: text("from_addr"),
  toAddr: text("to_addr"),
  subject: text("subject"),
  messageDate: timestamp("message_date"),
  bodyText: text("body_text"),
  fetchedAt: timestamp("fetched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MailMessage = typeof mailMessagesTable.$inferSelect;
