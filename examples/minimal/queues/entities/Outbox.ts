/** An email the service sent. */
export type Outbox = {
  to: string;
  subject: string;
  sentAt: Date;
};
