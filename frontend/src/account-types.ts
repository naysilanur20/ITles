export type Session = {
  organization: { id: string; name: string; account?: string };
  user?: {
    id: string;
    login: string;
    role: "admin" | "user";
    must_change_password?: boolean;
    legacy_access?: boolean;
  };
  demo: boolean;
  data_period?: { start: string; end: string };
  onboarding?: {
    completed?: boolean;
    step?: string;
  };
};
