import codecs
import os.path

import setuptools

setuptools.setup(
    name='labbox',
    version='0.1.17',
    author="Jeremy Magland",
    author_email="jmagland@flatironinstitute.org",
    description="",
    url="https://github.com/flatironinstitute/labbox",
    packages=setuptools.find_packages(),
    include_package_data=True,
    scripts=[
        'bin/labbox_api'
    ],
    install_requires=[
        'numpy',
        'hither>=0.4.2',
        'kachery-p2p>=0.5.24',
        'websockets',
        'pyyaml'
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
    ]
)
