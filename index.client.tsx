import type {
  PluginClientContext,
  PluginClientContribution,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OvermindCommandView, OvermindAlertView } from "./client/ui/OvermindObservatoryView.js";
import { OvermindSettingsView } from "./client/ui/OvermindSettingsView.js";
import { useCallback } from "react";
import { AlertSchema } from "./shared/control.js";

function createCommandScreen(onOpenSettings: () => void) {
  return function CommandScreen(props: PluginScreenProps) {
    return <OvermindCommandView {...props} onOpenSettings={onOpenSettings} />;
  };
}

function createSetupScreen(client: PluginClientContext) {
  return function SetupScreen(props: PluginScreenProps) {
    const onBack = useCallback(() => client.openScreen({ screenId: "command" }), []);
    return <OvermindSettingsView {...props} onBack={onBack} />;
  };
}

function ObservatorySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const handlePress = useCallback(() => openScreen({ screenId: "command" }), [openScreen]);
  return (
    <SidebarRow
      icon="BrainCircuit"
      active={currentScreen?.screenId === "command" || currentScreen?.screenId === "setup"}
      onPress={handlePress}
    />
  );
}

export default function contribute(
  client: PluginClientContext,
): ReturnType<PluginClientContribution> {
  const CommandScreen = createCommandScreen(() => client.openScreen({ screenId: "setup" }));
  const removeScreen = client.addScreen({
    id: "command",
    title: "Overmind Command",
    Component: CommandScreen,
  });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: "overmind-command",
    title: "Overmind",
    Component: ObservatorySidebarItem,
  });
  const removeSetup = client.addScreen({
    id: "setup",
    title: "Overmind Settings",
    Component: createSetupScreen(client),
  });
  const removeSettings = client.addSettingsScreen({
    id: "routing",
    title: "Overmind Settings",
    icon: "Network",
    Component: OvermindSettingsView,
  });
  const removeAlerts = client.addTimelineRenderer({
    kind: "anomaly",
    version: 1,
    schema: AlertSchema,
    Component: OvermindAlertView,
  });
  return () => {
    removeScreen();
    removeSetup();
    removeSidebarItem();
    removeSettings();
    removeAlerts();
  };
}
