"""Changes to the softcam virtual camera driver, made while the Windows app is built.

Like OBS's virtual camera, Multistream Camera now always works in Zoom or Teams:
- With no picture coming from Multistream, softcam used to refuse to open (Zoom shows an error or nothing).
  Now it opens at 1280x720, 30 frames a second, and shows the resting picture (vcam/ms_placeholder.h: the
  Multistream logo and "Press Start virtual camera in Multistream").
- When Multistream starts sending, the real picture takes over by itself; when it stops, the last picture stays,
  darkened (softcam already did that part).
Run from the repository folder: python scripts/patch-softcam.py softcam-src
"""
import shutil, sys, pathlib

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'softcam-src')
f = src / 'src' / 'softcamcore' / 'DShowSoftcam.cpp'
s = f.read_text(encoding='utf-8')

def rep(a, b):
    global s
    if a not in s:
        raise SystemExit('patch-softcam: could not find: ' + a)
    s = s.replace(a, b, 1)

# the resting picture
shutil.copy('vcam/ms_placeholder.h', src / 'src' / 'softcamcore' / 'ms_placeholder.h')
rep('#include "DShowSoftcam.h"', '#include "DShowSoftcam.h"\n#include "ms_placeholder.h"')
# open even when Multistream is not sending yet (the size Multistream always sends)
rep('m_valid(m_frame_buffer ? true : false),', 'm_valid(true),')
rep('m_width(m_frame_buffer.width()),', 'm_width(m_frame_buffer ? m_frame_buffer.width() : 1280),')
rep('m_height(m_frame_buffer.height()),', 'm_height(m_frame_buffer ? m_frame_buffer.height() : 720),')
rep('m_framerate(m_frame_buffer.framerate())', 'm_framerate(m_frame_buffer ? m_frame_buffer.framerate() : 30.0f)')
# while waiting: the resting picture (before, this copied from an empty place when nothing had been sent yet)
rep('''            const std::size_t size = calcDIBSize(m_width, m_height);
            std::memcpy(pData, m_screenshot.get(), size);''',
'''            const std::size_t size = calcDIBSize(m_width, m_height);
            if (!m_screenshot)
            {
                m_screenshot.reset(new uint8_t[size]);
                msFillPlaceholder(m_screenshot.get(), m_width, m_height);
            }
            std::memcpy(pData, m_screenshot.get(), size);''')
f.write_text(s, encoding='utf-8')
print('patch-softcam: done')
