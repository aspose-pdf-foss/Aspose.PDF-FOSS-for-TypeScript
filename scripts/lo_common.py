# m2fp.4: start a private headless LibreOffice and connect to it over UNO.
# Run with LibreOffice's OWN python.exe, which carries the uno module; the
# soffice.exe beside it is the office started.
import os, sys, time, shutil, tempfile, subprocess
import uno
from com.sun.star.beans import PropertyValue

PROGRAM = os.path.dirname(sys.executable)
SOFFICE = os.path.join(PROGRAM, 'soffice.exe')
PORT = 2083


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


class Office:
    """A headless office with a throwaway profile, so no user setting leaks in."""

    def __enter__(self):
        self.profile = tempfile.mkdtemp(prefix='lo-profile-')
        self.proc = subprocess.Popen([
            SOFFICE, '--headless', '--invisible', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
            '-env:UserInstallation=' + uno.systemPathToFileUrl(self.profile),
            '--accept=socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT])
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        for _ in range(240):
            try:
                self.ctx = resolver.resolve('uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT)
                break
            except Exception:
                time.sleep(0.5)
        else:
            self.proc.kill()
            raise RuntimeError('LibreOffice did not start')
        self.smgr = self.ctx.ServiceManager
        self.desktop = self.smgr.createInstanceWithContext('com.sun.star.frame.Desktop', self.ctx)
        return self

    def __exit__(self, *exc):
        try:
            self.desktop.terminate()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=60)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)

    def version(self):
        cp = self.smgr.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider', self.ctx)
        node = cp.createInstanceWithArguments('com.sun.star.configuration.ConfigurationAccess',
                                              (prop('nodepath', '/org.openoffice.Setup/Product'),))
        return node.getByName('ooSetupVersionAboutBox')
