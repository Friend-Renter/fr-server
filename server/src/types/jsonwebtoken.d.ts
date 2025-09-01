declare module "jsonwebtoken" {
  export type JwtPayload = any;
  export type SignOptions = any;
  export type Secret = any;
  const jwt: any;
  export default jwt;
  export function sign(...args: any[]): any;
  export function verify(...args: any[]): any;
}
