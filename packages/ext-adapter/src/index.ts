import { createEffect, createSignal, on } from "solid-js"
import { registerDebuggerPlugin, PluginFactory } from "@solid-devtools/debugger"
import * as Locator from "@solid-devtools/locator"
import {
  Messages,
  onWindowMessage,
  postWindowMessage,
  startListeningWindowMessages,
} from "@solid-devtools/shared/bridge"
import { warn } from "@solid-devtools/shared/utils"

startListeningWindowMessages()

const extensionAdapterFactory: PluginFactory = ({
  forceTriggerUpdate,
  rootsUpdates,
  roots,
  handleComputationUpdates,
  handleSignalUpdates,
  setFocusedOwner,
  focusedState,
  setSelectedSignal,
}) => {
  const [enabled, setEnabled] = createSignal(false)
  Locator.addHighlightingSource(enabled)

  postWindowMessage("SolidOnPage", process.env.VERSION!)

  // update the graph only if the devtools panel is in view
  onWindowMessage("PanelVisibility", v => {
    if (!v) return setEnabled(false)
    const current = enabled()
    // the panel might have been closed and opened again—in that case we want to update the graph
    if (current) {
      setFocusedOwner(null)
      forceTriggerUpdate()
    } else setEnabled(true)
  })
  onWindowMessage("ForceUpdate", forceTriggerUpdate)
  onWindowMessage("SetSelectedOwner", setFocusedOwner)
  onWindowMessage("SetSelectedSignal", ({ id, selected }) => {
    const value = setSelectedSignal({ id, selected })
    if (value) postWindowMessage("SignalValue", { id, value })
  })

  // diff the roots, and send only the changed roots (edited, deleted, added)
  createEffect(() => {
    postWindowMessage("GraphUpdate", rootsUpdates())
  })

  // send the computation updates
  handleComputationUpdates(updates => {
    postWindowMessage("ComputationUpdates", updates)
  })

  // send the signal updates
  handleSignalUpdates(updates => {
    postWindowMessage("SignalUpdates", updates)
  })

  // send the focused owner details
  createEffect(() => {
    const details = focusedState.details
    if (details) postWindowMessage("OwnerDetailsUpdate", details)
  })

  // TODO: abstract state sharing to a separate package
  // state of the extension's locator mode
  const [extLocatorEnabled, setExtLocatorEnabled] = createSignal(false)
  Locator.addLocatorModeSource(extLocatorEnabled)
  onWindowMessage("ExtLocatorMode", setExtLocatorEnabled)
  createEffect(
    on(Locator.locatorModeEnabled, state => postWindowMessage("AdpLocatorMode", state), {
      defer: true,
    }),
  )

  // intercept on-page components clicks and send them to the devtools panel
  Locator.addClickInterceptor((e, component) => {
    if (!enabled()) return
    e.preventDefault()
    e.stopPropagation()
    const { id, rootId } = component
    postWindowMessage("SendSelectedOwner", { nodeId: id, rootId })
    return false
  })

  let skipNextHoveredComponent = true
  let prevHoverMessage: Messages["SetHoveredOwner"] | null = null
  // listen for op-page components being hovered and send them to the devtools panel
  createEffect(() => {
    const hovered = Locator.highlightedComponent()[0] as Locator.HoveredComponent | undefined
    if (skipNextHoveredComponent) return (skipNextHoveredComponent = false)
    if (!hovered) {
      if (prevHoverMessage && prevHoverMessage.state)
        postWindowMessage(
          "SetHoveredOwner",
          (prevHoverMessage = { nodeId: prevHoverMessage.nodeId, state: false }),
        )
    } else {
      postWindowMessage("SetHoveredOwner", (prevHoverMessage = { nodeId: hovered.id, state: true }))
    }
  })

  onWindowMessage("HighlightElement", payload => {
    if (!payload) return Locator.setTarget(null)
    let target: Locator.TargetComponent | HTMLElement
    // highlight component
    if (typeof payload === "object") {
      const { rootId, nodeId } = payload
      const root = roots()[rootId]
      if (!root) return warn("No root found", rootId)
      const component = root.components().find(c => c.id === nodeId)
      if (!component) return warn("No component found", nodeId)
      target = { ...component, rootId }
    }
    // highlight element
    else {
      const element = focusedState.elementMap[payload]
      if (!element) return warn("No element found", payload)
      target = element
    }
    Locator.setTarget(p => {
      if (p === target) return p
      // prevent creating an infinite loop
      skipNextHoveredComponent = true
      return target
    })
  })

  return { enabled }
}

let registered = false
/**
 * Registers the extension adapter with the debugger.
 */
export function useExtensionAdapter() {
  if (registered) return warn("Extension adapter already registered")
  registered = true
  registerDebuggerPlugin(data => {
    const { enabled } = extensionAdapterFactory(data)
    return {
      enabled,
      observeComputations: enabled,
    }
  })
}