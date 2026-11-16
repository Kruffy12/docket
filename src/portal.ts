// Thin bridge to the Rust portal client. The session token stays in Rust.
import { invoke } from "@tauri-apps/api/core";
import { PortalError, type Transport } from "./core/executor";

export interface Me {
  username: string;
  role: string;
  secondaryRole: string;
  displayName: string;
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw PortalError.from(e);
  }
}

export const portal = {
  session: () => wrap(invoke<Me | null>("portal_session")),
  login: (username: string, password: string) => wrap(invoke<Me>("portal_login", { username, password })),
  logout: () => wrap(invoke<void>("portal_logout")),
};

export const portalTransport: Transport = {
  call: (action, id, data) => wrap(invoke("portal_call", { action, id: id ?? null, data: data ?? {} })),
};
