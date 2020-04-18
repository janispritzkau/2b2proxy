import { ReactiveEffect, ReactiveEffectOptions, effect, stop } from "@vue/reactivity"
import { Profile } from "./data"
import fetch from "node-fetch"

export function debounce<A extends any[]>(callback: (...args: A) => any, wait = 500, maxWait = wait) {
  let last = Date.now()
  let timeout: any = null

  return function (this: any, ...args: A) {
    clearTimeout(timeout)

    timeout = setTimeout(() => {
      callback.apply(this, args)
      last = Date.now()
    }, Date.now() - last > maxWait ? 0 : wait)
  } as unknown as (...args: A) => any
}

export type EffectDeepTrackFn = (key: any, fn: () => ReactiveEffect | void) => void

export function effectDeep(fn: (track: EffectDeepTrackFn) => void, options?: ReactiveEffectOptions) {
  const tracked = new Map<any, ReactiveEffect | void>()

  return effect(() => {
    const keys = new Set<any>()

    fn((key, track) => {
      if (!tracked.has(key)) tracked.set(key, track())
      keys.add(key)
    })

    tracked.forEach((effect, key) => {
      if (!keys.has(key)) {
        tracked.delete(key)
        if (effect) stop(effect)
      }
    })
  }, {
    ...options, onStop() {
      tracked.forEach(effect => effect && stop(effect))
      options?.onStop?.()
    }
  })
}

export async function validateOrRefreshToken(profile: Profile): Promise<boolean> {
  let response = await fetch("https://authserver.mojang.com/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: profile.accessToken })
  })

  if (!response.ok) {
    response = await fetch("https://authserver.mojang.com/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: profile.accessToken })
    })

    if (response.ok) {
      profile.accessToken = (await response.json()).accessToken
    }
  }

  return response.ok
}
