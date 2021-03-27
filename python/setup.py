import codecs
import os.path

import setuptools

setuptools.setup(
    packages=setuptools.find_packages(),
    include_package_data=True,
    scripts=[
        'bin/labbox_start_api_websocket',
        'bin/labbox_start_api_http'
    ],
    install_requires=[
        'numpy',
        'hither>=0.5.2',
        'kachery-p2p>=0.8.2',
        'websockets',
        'pyyaml',
        'aiohttp',
        'aiohttp_cors'
    ]
)
