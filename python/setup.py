import codecs
import os.path

import setuptools

setuptools.setup(
    name='labbox',
    version='0.1.26',
    author="Jeremy Magland",
    author_email="jmagland@flatironinstitute.org",
    description="",
    url="https://github.com/flatironinstitute/labbox",
    packages=setuptools.find_packages(),
    include_package_data=True,
    scripts=[
        'bin/labbox_start_api_websocket',
        'bin/labbox_start_api_http'
    ],
    install_requires=[
        'numpy',
        'hither>=0.4.2',
        'kachery-p2p>=0.8.0',
        'websockets',
        'pyyaml',
        'aiohttp',
        'aiohttp_cors'
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
    ]
)
