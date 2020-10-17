import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  // 如果fn是一个effect函数，则将fn.raw(原始函数)赋值给fn
  if (isEffect(fn)) {
    fn = fn.raw
  }
  // 创建effect对象
  const effect = createReactiveEffect(fn, options)
  // options中lazy为false，即effect不是懒加载的，则调用effect
  if (!options.lazy) {
    effect()
  }
  // 返回effect函数
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    // 如果active为false
    if (!effect.active) {
      // 如果options不存在scheduler则调用fn
      return options.scheduler ? undefined : fn()
    }
    // 如果自己不再effectStack中
    if (!effectStack.includes(effect)) {
      // 清空自己所以依赖的target，并重新收集
      cleanup(effect)
      try {
        // 允许收集依赖
        enableTracking()
        // 将自己加入当前effectStack
        effectStack.push(effect)
        // 将自己设置为activeEffect
        activeEffect = effect
        // 调用fn
        return fn()
      } finally {
        // 将自己出栈
        effectStack.pop()
        // 重新设置 是否允许收集依赖依赖
        resetTracking()
        // 重新设置是否activeEffect
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  effect.id = uid++
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果shouldTrack为false，或者activeEffect为undefined，则直接返回
  if (!shouldTrack || activeEffect === undefined) {
    return
  }

  // 过去target对应despMap
  let depsMap = targetMap.get(target)
  // 如果不存在depsMap则创建
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 获取target的key对应的dep Set
  let dep = depsMap.get(key)
  // 如果不存在则创建
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  // 如果dep没有activeEffect，即当前的effect没有被收集到target的key的依赖中,则添加当前effect到dep中
  if (!dep.has(activeEffect)) {
    // 收集effect
    dep.add(activeEffect)
    // 将dep添加到当前effect的deps中，在cleanup函数中可以直接获取到该dep
    activeEffect.deps.push(dep)
    // 开发环境下设置
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取target的depsMap
  const depsMap = targetMap.get(target)
  // 如果不存在depsMap，则返回
  if (!depsMap) {
    // never been tracked
    return
  }

  // 定义effects 存储需要粗发的依赖
  const effects = new Set<ReactiveEffect>()
  // 定义add函数来将effect添加到effects
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.options.allowRecurse) {
          // 如果effect不等于当前的effect，添加到effects
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    // 如果是clear操作，则将depsMap所有的effect添加到effects
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    // 如果target是数组且length改变了，
    depsMap.forEach((dep, key) => {
      // 如果key是length或者key >= newValue
      /**
       * key >= newValue等情况是怎么回事:
       * arr = [1, 2, 3]
       * 当arr.length = 1，newValue = 1
       * 而key有如下值 length， 0(下标), 1(下标), 2(下标)，
       * 当arr.length = 1，arr[1] arr[2]的值就被删掉了，需要触发对应的依赖
       */

      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 处理普通object的set,add和delete操作
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 处理Array，Map，Set特殊类型的add，delete，set操作
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  // 调用reactiveEffect函数
  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  effects.forEach(run)
}
