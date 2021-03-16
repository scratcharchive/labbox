__version__ = "0.1.27"

import os
import sys

from .api._workersession import WorkerSession
from .serialize import serialize

try:
    from .request_handlers import load_jupyter_server_extension
except:
    print('WARNING: unable to import load_jupyter_server_extension - okay if not using jupyterlab')

dummy = 0
