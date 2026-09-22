using System;
using System.IO;
using System.Windows.Forms;

namespace CourseStow.ControlPanel
{
    internal interface IFolderPicker
    {
        string SelectFolder(IWin32Window owner, string description, string initialPath);
    }

    internal sealed class WindowsFolderPicker : IFolderPicker
    {
        public string SelectFolder(IWin32Window owner, string description, string initialPath)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = description;
                dialog.ShowNewFolderButton = true;
                if (!String.IsNullOrWhiteSpace(initialPath) && Directory.Exists(initialPath))
                    dialog.SelectedPath = initialPath;
                return dialog.ShowDialog(owner) == DialogResult.OK ? dialog.SelectedPath : null;
            }
        }
    }

    internal interface IExecutablePicker
    {
        string SelectExecutable(IWin32Window owner, string initialPath);
    }

    internal sealed class WindowsExecutablePicker : IExecutablePicker
    {
        public string SelectExecutable(IWin32Window owner, string initialPath)
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Title = "Choose a compatible Chromium browser";
                dialog.Filter = "Windows applications (*.exe)|*.exe";
                dialog.CheckFileExists = true;
                dialog.CheckPathExists = true;
                dialog.Multiselect = false;
                if (!String.IsNullOrWhiteSpace(initialPath))
                {
                    string directory = Path.GetDirectoryName(initialPath);
                    if (Directory.Exists(directory)) dialog.InitialDirectory = directory;
                    if (File.Exists(initialPath)) dialog.FileName = Path.GetFileName(initialPath);
                }
                return dialog.ShowDialog(owner) == DialogResult.OK ? dialog.FileName : null;
            }
        }
    }
}
