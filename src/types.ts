export type TLeaseInfo = {
  status: "free" | "leased";
  holderIdentity?: string;
  expiresAt?: string;
};
export type TPodsresponse = {
  name: string;
  ready: boolean;
  lease: TLeaseInfo;
}[];

export type TPodInfo = {
  name: string;
  ready: boolean;
};
