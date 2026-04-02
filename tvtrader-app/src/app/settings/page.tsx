import Header from '../../components/Header';
import SettingsForm from '../../components/SettingsForm';

export default function SettingsPage() {
  return (
    <>
      <Header />
      <main className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16 py-6 lg:py-8">
        <div>
          <h2 className="text-lg lg:text-xl font-semibold mb-6">Settings</h2>
          <SettingsForm />
        </div>
      </main>
    </>
  );
}
