import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { SettingsHub } from '@/components/settings-hub';
import { getCurrentOrganization, getModules } from '@/lib/api';
import {
  SETTINGS_SECTIONS,
  visibleSettings,
  type SettingsSectionKey,
} from '@/lib/settings-catalog';

export const dynamic = 'force-dynamic';

/**
 * Settings, all in one place. Each entry goes to the page that holds the
 * setting; nothing is changed here, so every rule stays where it lives.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { section } = await searchParams;
  const modules = await getModules();
  const enabled = new Set(modules.filter((m) => m.enabled).map((m) => m.key));
  const settings = visibleSettings(organization.permissions, enabled);
  const sections = SETTINGS_SECTIONS.filter((entry) =>
    settings.some((setting) => setting.section === entry.key),
  );
  const focus = sections.some((entry) => entry.key === section)
    ? (section as SettingsSectionKey)
    : null;

  return (
    <>
      <AppNav current="settings" />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Everything you can set up for yourself and {organization.organization.name}, in one place.
        </p>
        <SettingsHub sections={sections} settings={settings} focus={focus} />
      </main>
    </>
  );
}
